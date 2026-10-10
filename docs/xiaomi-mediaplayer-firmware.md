# 小爱音箱固件逆向：`mediaplayer` 播放接口字段手册

> 固件：`thirdparty/mico_firmware_4215788a8_1.62.6.bin`（LX01，ROM 1.62.6，OpenWrt 3.4.39，ARM32 musl）
> 目标：回答“`play_music_url` 里那一堆字段怎么用、还有哪些字段”——以固件为准，不是以某开源库为准。
> 方法：静态分析 `usr/bin/mediaplayer`（strip、无节表）。云端抓包结论（MiService/xiaomusic 那条线）只做对照，不当证据。

## 1. 固件与解包

| 偏移 | 内容 |
|---|---|
| `0x0` | `HDR1` 头（含 `config core 'version'`，`ROM '1.62.6'`，`HARDWARE 'LX01'`） |
| `0x5D88` | uImage kernel（ARM OpenWrt Linux-3.4.39） |
| `0x9D6B` | gzip 数据 |
| `0x4003C8` | squashfs（xz，25MB，2177 inodes）→ 解出 2176 个文件 |

工具链（全在 orb 的 ubuntu 里现装，本机 macOS 不缺也不装）：`binwalk`、`squashfs-tools`（apt）；`capstone`+`pyelftools`（pip，用于无节表 ELF 的反汇编；`radare2/rizin` 在 ubuntu noble 源里没有，没装也够用）。产物在 `work-fw/`：`rootfs/`（解包结果）、`rootfs.sqsh`、`xref3.py`（LDR 字面量暴力扫描）、`disas.py`（指定 VA 区间反汇编 + 字符串引用标注）、`dis_*.txt`（关键函数反汇编存档）。

核心手法：无节表导致 `objdump -d` 直接罢工（0 输出），改用“编码模式匹配”找所有 `LDR-literal`（ARM32:`(w&0x0F7F0000)==0x051F0000`；Thumb16:`(h&0xF800)==0x4800`），再把字面量池里的指针解引用到字符串，共命中 81 处。ubus 方法表是静态数组（`{name, handler, 0, 0, policy, n_policy}`，24 字节/项），policy 又是 `{name, type}` 数组（3=string / 5=int32 / 7=bool-int），直接从 rodata 抠出全表。

## 2. ubus 方法表（`mediaplayer` 对象，节选）

共 30+ 方法，含 `test`（见 §6）。两个播放入口：

### `player_play_url`（handler 0x15fd8），10 个策略字段

| 字段 | 类型 | 必填？ |
|---|---|---|
| `url` | str | ✅ 缺了回 `code=1` |
| `type` | u32 | ✅ 缺了回 `code=1` |
| `group` `media` `src` `dialog_id` `id` `instruction_id` | str | 否，缺省 `""` |
| `duration` | u32 | 否 |
| `auth` | bool | 否，handler 内归一化为 0/1 |

handler 原样透传给内部函数 `0x260d4`（日志前缀 `mi_play_url,url:%s,type:%d,group:%s,…`）。结论：`qr_mina_play.py` 只发 `{url, type, media}` 是合法子集；`media:"app_ios"` 只是透传标识。

### `player_play_music`（handler 0x166e4），10 个策略字段

| 字段 | 类型 | 必填？ |
|---|---|---|
| `music` | str（内层 JSON 的**字符串化**） | ✅ 唯一必填 |
| `startaudioid` | str | 否，缺省 `""`（handler 层面**不强制**等于 `audio_id`，云端发一样的值只是习惯） |
| `startOffset` | u32 | 否，缺省 0（断点续播位，单位待定） |
| `group` `media` `dialog_id` `id` `instruction_id` | str | 否，缺省 `""` |
| `src` | str | 否，缺省 `"mediaplayer"`（⚠️ 全表唯一一个缺省不是空串的） |
| `duration` | u32 | 否 |

### 同对象其他播放相关方法（一句话版）

`player_play_operation{media,action,…}`（action=pause/stop/play）、`player_set_loop{type,media}`、`player_set_positon{position,media}`（注意拼写，固件原文如此）、`player_play_index{index,media}`、`player_play_album_playlist{type,id,startOffset,media}`、`player_play_private_fm`、`player_get_latest_playlist`、`player_play_resource{message,src,volume}`、`player_play_alarm_reminder{id,type,reminder,volume,timeReminder,query}`、`player_set_volume{volume,media,beep,type,unit,tts_silence,lednum}`、`player_modify_volume{isVolumeUp,value,type,unit,tts_silence}`、`player_get_play_status`（无参数）。

## 3. `music` 内层 JSON 全字段（`parse_audio_player` 实际解析顺序）

- 顶层：`payload`（缺了直接 `failed by no payload field` 返回）、`play_behavior`、`audio_type`、`loadmore_token`、`loadmore_delta`、`needs_loadmore`、`favorites_id`、`origin_id`、`play_duration`、`list_params`、`audio_items`（空数组 `failed by items_len=0` 返回）、`stop_by_count`、`play_position`、`stop_by_time`
- `list_params`：`listId`、`type`、`origin`、`loadmore_offset`（`stop_by_*`/`play_position` 疑似也挂在这层，寄存器追踪未钉死，待定）
- `audio_items[]`：`item_id`、`stream`、`item_type`、`play_times`、`skip_controls`（只认 `"NEXT"`/`"PREV"`）、`log`
- `item_id`：`audio_id`、`cp{name,id,album_id}`、`episode_index`
- `stream`：`url`、`token`、`redirect`、`authentication`、`offset_in_ms`、`duration_in_ms`

## 4. 两个关键语义

**`audio_type` 是字符串枚举，固件 `strncmp` 映射成 int**（`""` 和 `TTS` 都是 0）：

| 字符串 | int | 字符串 | int |
|---|---|---|---|
| MUSIC | 3 | WHITE_NOISE | 14 |
| NEWS | 8 | VOICE | 4 |
| RADIO_STATION | 6 | JOKE | 15 |
| BOOKS | 5 | TRANSLATION | 16 |
| ANCIENT_POEM | 9 | TTS / 缺省 | 0 |

该 int 决定灯效（`audio_type:%d led_num:%d` → `/bin/show_led 14`），即“`MUSIC` 点亮灯环”的固件依据。另：`audio_type==14(WHITE_NOISE)` 时还会拿一个内部字符串字段去匹配 12 个子类型（`WHITE_NOISE_FIRE/SEA_WAV/SEA_WAV_MEW/RAIN/FOREST/TRAVEL/SPRING/LIBRARY/RURAL/SUMMER_NIGHT/BIRD_SONG` 等，完整列表见 `work-fw/dis_parse3.txt`）选 melody。

**`play_behavior` 固件只显式比对 `REPLACE_ALL`**：命中则先清空旧队列（`0x25168`）再进公共流程；不命中直接进公共流程（= 追加语义）。`APPEND`/`REPLACE_PENDING` 只存在于 `libaivs_sdk.so` 的字符串池，`mediaplayer` 自身没有——发别的值不会报错，效果等于追加。

## 5. 与 `src/qr_mina_play.py` 的对照

- 真正起作用的只有 **`stream.url`**；`audio_id/cp/list_params` 全是伪装成“小微歌单”的占位符。
- `startaudioid` 发空固件也收；发和 `audio_id` 一样的值只是顺着云端习惯。
- 想补全的话，`startOffset/dialog_id/instruction_id/duration` 都是原生支持的；`auth` 只有 url 路径有，music 路径没有。
- 另有第二方言：`generate_track_list` 用 `urllist[]` + **`audiotype`**（无下划线）+ 同一套 10 枚举，是另一条（本地恢复/收藏）路径的格式，云端下发不用管。

## 6. 有趣的发现（和播 URL 无关，但有意思）

- **固件作者的拼写**：`player_play_commad`（command 少个 n）、`player_set_positon`（position 少个 i）、`player_retore_last_volume`（restore 少个 s）——三个 typo 方法名全进了 ubus 表，云端调它们时也得跟着拼错。shell 里也有：`check_mediaplayer_status` 写 `voip_status="unkown"`（unknown 少个 n）。
- **运营商全家桶**：`cmcc_andlink_daemon`、`cmcc-ims`、`cmcc_helper`，还有 `cmcc-andlink-deamon`/`cmcc-dm-deamon`（daemon 拼成 deamon，又是 typo，两个版本并存）。`carrier_chinatelecom.sh` 说明电信也有定制。
- **`matool_*` 有 65 个**：`matool_get_music_recommendation`、`matool_collect_stat_points`、`matool_2b_guest_checkout`……一看就是“万能查询后门”风格的存在。
- **`bin/notify.sh` 的注释**：关机音效那行 `player_play_url {file:///usr/share/sound/shutdown.mp3}` 被注释掉了，改走 `qplayer play {/usr/share/common_sound/shutdown.opus}`——说明后期切了播放器；但 `ble/setup` 还是走 mediaplayer。以及 `wakeup.sh` 用 `player_play_url` 播本地 `first_voice.opus`（`type` 参数直接透传 `$1`），证明 `file://` + `player_play_url` 是官方自己也在用的招。
- **音箱里塞了 `htop`/`iperf`/`iozone`**：出厂固件带性能测试和网络测试工具，调试味很重。`test` 方法（空参数）就是给 `check_mediaplayer_status` 做 ubus 心跳的（10 秒超时，失败就 `/etc/init.d/mediaplayer restart`，简单粗暴）。
- **LED 是 shell  remote 调的**：`export LED_PARENT=player;/bin/show_led 14`，还有独立 `ledserver`。想玩灯效可以直接调。
- ** Supplement**：`_fit_` 段（0x590K 起）还没展开，里面一般是设备树/多分区镜像，有兴趣可以继续。

## 7. 意外（逆向过程中的翻车与修正）

1. **`.tmp` 是个 symlink**：`ls -la` 才发现 `.tmp -> /tmp`，之前 subagent 写到 `.tmp/...` 的取证产物全落进了禁用的 `/tmp`。本次新建真目录 `work-fw/` 规避。同样 `thirdparty -> ../campro/thirdparty` 也是链接，跨仓库引用时注意。
2. **capstone 的 `CS_OP_MEM` 是 3 不是 2**：第一版 xref 脚本按 `op.type==2` 过滤，结果 0 命中、白跑 4 万条指令——2 其实是 `CS_OP_IMM`。教训：别背常量，用名字。
3. **脚本文件名撞标准库**：`work-fw/dis.py` 导致 `capstone → inspect → import dis` 循环导入，改名 `disas.py` 解决。
4. **`unsquashfs` 报 `xz: error reading stored compressor options` 但解包完整**（2176/2177 inodes），是新版工具对老格式的警告，无视即可。
5. **`"audio_type"` vs `"audiotype"`**：两个字符串都存在，一度以为看错了。其实是两条路径两种方言（§5），不是 typo。
6. **APK 与固件对不上**：米家 11.7.704 的 dex 里 `player_play_url` 计数为 0，但固件 ubus 表里明明有——说明该版 App 只走 music 法，url 是更新的服务端能力；反过来 `1582971365183456177` 这串“魔法 ID”在 dex 和固件里都不存在，是 Python 生态客户端侧的占位符。两边互相印证了 fallback 策略的合理性。

## 8. 值得深入的点

- `0x25abc`（music 内部处理）：`startaudioid` 与首项 `audio_id` 不一致时会怎样？目前只知 handler 不检查，内部未知。
- `type=1 vs 2`（play_url）：handler 只透传，语义藏在 `0x260d4`（`mi_play_url_prcocess`，固件也拼错了 process）里，没跟进去。
- `auth` 字段（play_url 独有）：bool，内部用途未知；`dialog_id/instruction_id` 为空时内部会 `generate dialogId`，自造 ID 的规则值得一看（断线重连/状态上报可能用它对齐）。
- `loadmore_token/loadmore_delta/needs_loadmore` + `LoadMore` 事件上报（`aivs_event_post … origin_id/token/offset/delta`）：长列表翻页协议，播歌单时有用。
- `qplayer` vs `mediaplayer`：notify.sh 显示部分场景已切 qplayer，它的 ubus 表可能有另一套接口。
- `libaivs_sdk.so` 的 `REPLACE_PENDING`：谁在发？`mico_aivs_lab` 还是云端直连？可能对应“插播”语义。
- FIT 段和 kernel modules（`bcmdhd.ko` 等）：和播放无关，玩驱动/改机才需要。
