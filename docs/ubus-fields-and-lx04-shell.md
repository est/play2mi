# 小爱音箱 ubus 播放字段手册 + LX04 shell 复活研究

日期：2026-10-10。实验设备：LX04（小爱触屏音箱，romVersion 2.42.118，IP 192.168.31.146），
固件对照：LX01 mico_firmware_4215788a8_1.62.6.bin（thirdparty/ 下）。
工具与脚本全部在 `work-fw/`（真实目录，**不是** `.tmp`——注意仓库里 `.tmp` 是指向 /tmp 的软链接，别用）。

---

## 一、ux050 `play_music_url` 字段手册（LX01 1.62.6 固件逆向 + 三方库对照）

### 1.1 ubus 方法表（`usr/bin/mediaplayer` 对象 `mediaplayer`，blobmsg 类型 3=string/5=u32/7=bool）

| method | 字段（policy 全表） | 类型 |
|---|---|---|
| `player_play_operation` | action, media, message, group, dialog_id, instruction_id | |
| `player_play_url` | **url**(str), **type**(u32), group, media(默认""), src, dialog_id, id, instruction_id, duration(u32), auth(bool) | 10 个 |
| `player_play_music` | **music**(str, 内层 JSON 的字符串化), startaudioid(默认""),
 startOffset(u32), group, media, src(默认"mediaplayer"), dialog_id, id, instruction_id, duration(u32) | 10 个 |
| `player_set_positon` | position(u32), media | |
| `player_set_loop` | type(u32), media | |
| `player_set_volume` | volume(u32), media, beep(u32), type, unit, tts_silence(bool), lednum(u32) | |
| `player_get_play_status` / `player_set_loop` 等 | 无参数或少量 | |

handler 层：未提供的 str 字段置 ""、u32 置 0。`player_play_url` 必须有 `url` 否则直接错误。
`player_play_music` 唯一必填 `music`；`startaudioid` 可空，handler 不强制等于内层 audio_id（云端习惯发同样的值）。

### 1.2 `music` 内层 JSON（`parse_audio_player` 解析顺序）

顶层：`payload`（缺则报错）、`play_behavior`、`audio_type`、`loadmore_token`、`loadmore_delta`、`needs_loadmore`、
`favorites_id`、`origin_id`、`play_duration`、`list_params`、`audio_items`（缺/空则报错）、`stop_by_count`、`play_position`、`stop_by_time`。

`list_params`：`listId`、`type`、`origin`、`loadmore_offset`（+ `stop_by_*`/`play_position`，待定）。

`audio_items[]`：`item_id`、`stream`、`item_type`、`play_times`、`skip_controls`（仅 `NEXT`/`PREV`）、`log`。
`item_id`：`audio_id`、`cp{id, name, album_id}`、`episode_index`。
`stream`：`url`（唯一真正承载）、`token`、`redirect`、`authentication`、`offset_in_ms`、`duration_in_ms`。

结论：`audio_id`/`cp{...}`/`list_params` 全是占位符（伪装"小微歌单"），仅 `stream.url` 起作用；
`startaudioid` 是外层冗余报名。

### 1.3 `audio_type` 枚举（固件 `strncmp` 直映 int，决定灯效 `show_led 14`）

`MUSIC=3, NEWS=8, RADIO_STATION=6, BOOKS=5, ANCIENT_POEM=9, WHITE_NOISE=14, VOICE=4, JOKE=15, TRANSLATION=16, TTS=""=0`。
`WHITE_NOISE` 另有 12 个子类型（`WHITE_NOISE_FIRE/SEA_WAV/RAIN/…`）对应 cp_led 灯效 melody。

### 1.4 `play_behavior`

固件只显式对比 `REPLACE_ALL`：命中→先清队列再播；否则直接进队列（≈ append）。
`APPEND`/`REPLACE_PENDING` 只在 `libaivs_sdk.so` 里出现，mediaplayer 不认识。

---

## 二、LX04 (2.42.118) 云端可控面实测 & shell 研究

### 2.1 LX01 固件解包方法论（可复用）

```
binwalk thirdparty/mico_firmware_*.bin   # 自动忽略 HDR1 头
# → uImage kernel@0x5D88, squashfs@0x4003C8
dd if=bin of=rootfs.sqsh bs=1 skip=4195272 status=none
unsquashfs -d rootfs rootfs.sqsh         # 2177 个文件
```
关键二进制：`usr/bin/mediaplayer`（ubus 播放核心）、`mibrain_service` / `mico_aivs_lab`（云端指令处理）、
`mico-helper`（通知）。解析脚本：`work-fw/xref3.py`（LDR-literal 交叉引用）、
`work-fw/runs.py`（自动抠 ubus 方法+policy 表）、`work-fw/plt.py`/`pltx.py`（musl PLT 还原）。

### 2.2 LX01 已定位的注入 sink（未外发验证）

- **`tts_play.sh '%s'`**（`mico-helper` 0x14038）：`pipe_exe` 无转义 → 本地 `sh -c`，root。触发链：
 云端通知 → mico-helper `notify.create`（policy: id/level/expire/volume/text）→ 播放通知时拼 shell。
- `mibrain_service`：vendor 切换路径多处 `system()`/`snprintf("%s")`（0x15f40 等）。
- 校验：LX01 静态未见 vendor_name 名单校验（但被 2.4 的云端网关挡死，见下）。

### 2.3 LX04 与 LX01 架构差异（关键！）

LX04 的 ≥2.30 是 **Android**，不是 LX01 那套 OpenWrt。原 native daemon 全没了：
- payload.bin（Android OTA, magic `CrAU`）→ `payload-dumper-go` 解出 `system/vendor` ext4。
  mico 栈 = `MicoLauncher.apk`（Java, 6个 dex）+ JNI（libmibrainsdk.so/libmiio_linux.so 等），无 shell 模板。
- `MicoVoip.apk`（70MB）电话；`mqtt.service.application` 云推送。
- miot spec v2：`xiaomi.wifispeaker.lx04`，关键 action `5.1 play-text`（已实测通）、`5.4 execute-text-directive`。

### 2.4 实测：LX04 云端 `remote/ubus` 白名单（UA=米家 iOS）

放行 path（HTTP ≠ 400）: **mediaplayer / mibrain**（全部方法转发，含任意字符串 message）、
mibt / miio / mode_manager / voip / power / alarm（转发但设备端对象大多数不存在→`code 900 ubus error`）。
- 未放行：notify、dlna、qplayer、linein、aux、bt、pns、usb_audio、led 等全 400。
- `mibrain` 内有用的方法（Java 层 `MiBrainUbusHandler` 反编译可读）：
  - `tts_vendor_show` / `tts_vendor_switch {vendor_name}` → 枚举校验（Java valueOf），**无 shell**。
  - `ai_tts_request {tts_text}` → 任意 TTS 播报。
  - **`ai_service {for_test, nlp_execute, nlp_text, nlp}` → 静默"文本即语音指令"入口（实测 code 0，
    用 on-wire 文本假冒用户语句送 NLP）。等价"替你对音箱说话"。**

### 2.5 三层校验/过滤链（谁拦的谁）

1. **云端网关**：对 `tts_vendor_switch.vendor_name` 做**取值枚举校验**（试纸 `XiaoMi'`/`;`/空格/反引号全
   code=101+无 device_data，而过期 device_data 会回显 3012/900——证明请求根本没到设备）。
2. **设备端 mina 侧**（LX01）：无（静态未见）。
3. **端上 Java/AIVS**：LX04 全枚举/资源型，无 shell；LX01 部分直插 shell。

### 2.6 shell 复活：试过的路和死因

| 路 | 结果 |
|---|---|
| TCP 1-1023+主流高端口扫 LX04 | 全关（无 adbd/dropbear/httpd/dlna） |
| UDP 54321 miio（hello/json） | 无响应（未开） |
| OTA 签名 (LX01 miso RSA) | 校验可行 → 不能喂包 |
| nano_httpd | 仅 127.0.0.1 |
| upnp-disc / dlna | 内部 mac 校验，无法注入 |
| `notify.create` → tts_play.sh 注入 | LX04 端 notify 对象未放行（LX01 理论可打） |
| `tts_vendor_switch` 注入 | 云端枚举拦截（2.5-1），设备端 Java 无 shell（LX04） |
| `aivs_event_post` ChildModeSwitch / path_child_mode | LX04 无此 handler（LX01 才有），无响应 |

### 2.7 结论与建议

- "改个怪异歌名/文件名/通知名 → 弹 shell"的预设**不成立**（LX04）。LX01 的 `tts_play.sh '%s'`
  确为真 bug，但栈在通知文本（账号行为可触发），风险受限，且需死磕云端推送通道。
- 已确认可行的"奇怪"玩法（无 shell）：
  1) 任意 HTTP URL 播放（qr_mina_play --play 已有）；
  2) **静默文本语音指令**（`ai_service` for_test，假冒用户放歌/换音色/查任何）；
  3) 屏幕设备 LX04 上可用 miot spec `5.4 execute-text-directive`。
- 复活建议优先级：**拆机 UART**（inittab 串口 login > dropbear）→ Linux 型号里底线可靠；
  Android 设备走 `adb_engineer`（工程 apk）路线待研究。

---

## 三、过程产物

- `work-fw/rootfs/` LX01 rootfs、`work-fw/*.py` 解析脚本、`work-fw/dis_*.txt` 反汇编片段。
- `work-fw/lx04/images/` LX04 各分区镜像；`work-fw/lx04/mica_jadx/` 主 APK decompiled。
- `work-fw/spec/` miot-spec v1/v2 JSON + RN 插件包；`thirdparty/lx04_fw/` XL04固件 dump。
- 实测脚本：`work-fw/probe_paths.py`（云端 path 白名单）、`work-fw/fire_nlp.py`（文本指令）。
