# 小米/米家 API 体系：登录 + 音响播 HTTP 媒体

> 归属：本文件 + `poc/qr_mina_play.py` + `poc/mi_auth.py` + `thirdparty/xiaogpt`
> 已从 campro（摄像头项目）移至本仓库。`thirdparty/` 其余探针
> （MiService/mijia-api/hass-xiaomi-miot/ha_xiaomi_home/python-miio/miloco）
> 仍在 campro，本文 §6–§7 提到它们时指 campro 下的对应目录。

目标：不盲目调库，先看清小米官方（及准官方）有哪些 API 面，各自管什么，再决定 from scratch 封装哪几层。
运行形态：Python 直调云 API，多型号小爱音响兼容。读者：懂一点 IoT 和 OAuth2。

`thirdparty/` 下的 6 个项目 + `xiaomi-ha-mcp-tutorial.html` 在这里只当“探针”——用它们反推 API 体系，而非使用指南。

## 1. 体系总览：5 层面

```
L1 账号与授权  account.xiaomi.com
 |  产出 serviceToken / access_token + userId / passToken
 v
L2 小爱云 Mina   api2.mina.mi.com (+ userprofile/m-music)
 |  小爱音响专属：设备表、ubus 指令通道（TTS/播 URL）
 v
L3 米家 IoT 云   api.io.mi.com/app ｜ api.mijia.tech/app
 |  全品类设备：device_list、miotspec prop/action、home rpc
 v
L4 语义层 MiOT-Spec  iot.mi.com / miotspec
 |  siid/piid/aiid 物模型：灯/风扇/音响都用同一套寻址
 v
L5 推送与集成层  MQTT(MIPS) / HA 官方集成
    设备主动上报 + 官方 OAuth 代管（html 教程走这里）
```

关键认知：**播 HTTP 音频只活在 L2**。L3/L4/L5 都只能做 TTS 或开关量，这是多型号兼容首先要接受的事实。

## 2. L1 账号与授权：三种拿票方式

小米账号体系只有一个根（`account.xiaomi.com`），但有三条拿票路径，`sid`（service id）决定票能进哪扇门：

| 路径 | 端点 | 输入 → 输出 | 票的用途 |
|---|---|---|---|
| B1 账密直登 | `GET /pass/serviceLogin?sid=xxx&_json=true` → `POST /pass/serviceLoginAuth2`（`user` + `MD5(password).upper()` + `qs/_sign/callback`）→ `GET {location}&clientSign=base64(sha1(nonce&ssecurity))` 取 cookie `serviceToken` | 账密 → `userId/passToken/ssecurity/serviceToken` | `sid=micoapi` 进 L2 小爱云；`sid=xiaomiio` 进 L3 IoT 云 |
| A1 扫码（米家 APP 形态） | `GET /pass/serviceLogin?sid=mijia` 取 `location` → 取 `loginUrl/qr/lp` → 米家 APP 扫码 → 长轮询 `lp`（~120s） | 人扫码 → 同 B1 的一套票，落盘持久化 | 同 B1，但不经手密码 |
| A2 标准 OAuth2（官方 HA/miloco 形态） | `GET /oauth2/authorize?client_id=...`（浏览器跳转授权）→ `POST /oauth2/token` → `refresh_token` 续期 | 人点授权 → `access_token/refresh_token`；MQTT 复用 `access_token` 当密码 | 进 L5 官方通道；不直接给 ubus 票 |

门槛与障碍：

- B1 最省代码（两次 POST），可无人值守，但风控最重：密码错（`70016`）、要图形验证（`87001`，换出口 IP 或人工过码）、要短信二次验证（返回 `notificationUrl`，需贴回 `passToken/userId`）。单账号服务器场景可用，但要有“人工过码入口 + 指数退避”预案，且明文密码的保管是硬伤。
- A1/A2 不存密码，合规，但首次必须有人（扫码 / 浏览器点授权 / 修 `homeassistant.local` hosts）。A1 的扫码长轮询和 A2 的回调服务器是自研时要自己写的两小块。
- 私有口令交换（B1/A1）返回的不是 JWT，而是 `ssecurity/serviceToken/cUserId` 三件套，后续每个业务请求靠 cookie（`userId/serviceToken`）+ 按 `ssecurity` 做签名（L3 的 RC4/HMAC，L2 靠 cookie + `requestId`）。OAuth 经验可迁移概念，不可照搬字段。

## 3. L2 小爱云 Mina：播 HTTP 的唯一正门

域名：`https://api2.mina.mi.com`，UA 伪装成米家 iOS（`MiHome/6.0.103 … MICO/iOSApp`），鉴权靠 L1 `sid=micoapi` 的 cookie。

| 端点 | 方法 | 用途 |
|---|---|---|
| `GET /admin/v2/device_list?master=0` | 查该账号下所有小爱设备，拿 `deviceID/hardware/model` | 先调它，再按 `hardware`（如 `LX04/LX05/L06/X08A/X10A/OH2…`）分双协议分支 |
| `POST /remote/ubus` | 万能指令通道。body：`{deviceId, method, path, message(JSON串)}`，另附 `requestId=app_ios_+rand` | 下表所有播放能力都走它 |
| `GET /music/song_info`、`.../aivs3/audio/info` | 查在播状态（社区集成用来自检） | 可选 |
| `userprofile.mina.mi.com/device_profile/v2/conversation` | 拉最近问答（调试用） | 可选 |

`POST /remote/ubus` 的 `method/path/message` 矩阵（`path` 只有两个值）：

| method | path | message | 效果 |
|---|---|---|---|
| `text_to_speech` | `mibrain` | `{"text": "…"}` | TTS，全型号最稳的兜底 |
| `player_play_url` | `mediaplayer` | `{"url": "https://…mp3", "type": 2, "media": "app_ios"}` | **播 HTTP URL（新固件）** |
| `player_play_music` | `mediaplayer` | `{"startaudioid": …, "music": "{payload.audio_items[].stream.url, play_behavior: REPLACE_ALL}"}` | **播 HTTP URL（老固件，`LX04…OH2` 一批）**，包一层伪音乐单 |
| `player_set_volume` / `player_play_operation{pause/stop/play}` / `player_get_play_status` / `player_set_loop` | `mediaplayer` | 对应 `{volume} / {action, media} / …` | 音量与启停 |
| `nlp_result_get` | `mibrain` | `{}` | 取最近一次语义结果 |

障碍清单（自研必须处理）：① **双协议分支**：先 `player_play_url`，失败 fallback `player_play_music`，按 `hardware` 预判只是优化；② URL 须**公网 http(s)**，自签名/多次重定向/`Content-Type` 非 `audio/*` 会被部分固件拒；③ 旧款（如 Play 增强版）连 TTS/`play_media` 都可能 500——这是固件能力，不是你代码 bug，先拿 Pro 版跑通再谈矩阵；④ 该层无 SLA，小米随时可改，生产代码要把“播 URL 失败 → TTS 兜底”写死。

## 4. L3 米家 IoT 云：管设备，不管播音

两个并存的入口，本质同一后台、不同 APP 壳：

- `https://{region.}api.io.mi.com/app`（`region` 为空即大陆，`de/i2/ru/sg/us` 为海外）：`POST /home/device_list`（拿 `did/model/token`）、`POST /home/rpc/{did}`（`{method: get_prop/set_…}` 老协议）、`POST /miotspec/prop/get|prop/set|action`（新协议，见 L4）。
- `https://api.mijia.tech/app`（米家 APP 壳）：同样 `miotspec/prop/action`，但整包要 `ENCRYPT-RC4`（`ARC4(ssecurity)` + sha256/sha1 签名头）。逆向成本在这里，不在业务语义。

结论：L3 能开关灯、调音量、发自然语言指令，但**没有“播 URL”语义**——自研不要从这里起步找播放接口。

## 5. L4 语义层 MiOT-Spec：统一寻址，别当播放通道

公开文档在 `iot.mi.com`（Spec-V2）。寻址三元组 `siid/piid/aiid`（服务/属性/动作），小爱音响常用的只是其中一组：`execute-text-directive`（自然语言，如“播放音乐xx”）、`play-text`（TTS）。官方 HA 集成把前者映射成 `Notify/Text` 用——所以它只能 TTS。

自研时 L4 只做两件事：查 `miot-spec.com` 拿某型号的 `siid/aiid` 表；播 URL 失败时用 `play-text` 兜底播报。其余播放逻辑回 L2。

## 6. L5 推送与集成层：html 教程的位置

`xiaomi-ha-mcp-tutorial.html` 全程活在 L5：Docker 起 HA → 装官方集成 → 跳 A2 OAuth（`account.xiaomi.com/oauth2/authorize`，无短信码是其最大卖点，回跳 `homeassistant.local` 失败要改 hosts）→ 拿 HA 长期 `Bearer` token → `home_mcp.py`（仅标准库 `urllib`）调 `POST /api/services/{domain}/{service}`（演示的只是 `notify/send_message` 做 TTS）。

在 API 体系里定位它：**用 HA 官方通道代管 L1+L3/L4，自己只调 HA REST + MCP**。代价：重依赖（HA+Docker+网关；真本地还要大陆版中央网关）、能力天花板（无播 URL、Play 增强版 500）、`entity_id` 映射维护。适合灯/风扇/传感器的 AI 玩具，不适合本目标。自研借鉴点只有一个：它的 OAuth 代管思路 = 上文 A2 路径的产品化样子。

## 7. 探针项目 ↔ API 覆盖（只看覆盖面，不看文件名）

| 项目 | 覆盖 | 局限 |
|---|---|---|
| MiService | L1-B1 + L2 全矩阵 + L3 IoT | 逆向 UA/签名，风控自理；`play_list` 靠时长轮询脆 |
| mijia-api | L1-A1 + L3（RC4 壳）+ L4 指令 | 无 L2，所以无播 URL；GPL-3.0，**只看逻辑别抄代码** |
| hass-xiaomi-miot | L1-B1 + L2 双分支 + L3/L4 | 社区实现，密码存 yaml，LAN+轮询 |
| ha_xiaomi_home（官方） | L1-A2 + L3/L4/L5(MQTT 推送) | 正统但无 L2 播 URL |
| miloco（官方 Agent） | L1-A2 + L5 + L4 `play-text` | 重型 Agent，播 URL 要自拼 L2 |
| python-miio | 局域网 `IP+token`（L3 的本地投影） | 无账号体系，无播 URL |

依赖极简版：自研直调云只需 `requests/httpx`（+ 可选 `pycryptodome` 做 L3 RC4，若不碰 L3 则不需要）；凡是要 HA 的（后四者）都不在 from scratch 路径上。

## 8. from scratch 实施顺序

1. L1 二选一：内部单账号先做 B1（两次 POST + `~/.mi.token` 持久化 + 风控分支）；对外/多用户再做 A1 扫码或 A2 回调。
2. L2 三连调：`device_list` → `text_to_speech`（验票与设备）→ `player_play_url`（验播音），失败自动切 `player_play_music`。
3. L4 兜底：`play-text` TTS；L5 不做。
4. 型号矩阵：以 `hardware` 为 key 记录 `play_url/play_music/TTS-only` 三档，Play 增强版这类先标 TTS-only。

## 9. 实测验证（X08C，2026-10，`poc/qr_mina_play.py` 纯标准库）

- 扫码（`sid=mijia`）→ 免密换 `sid=micoapi` / `sid=xiaomiio` 票：可行，全程无密码无短信。
- 播 HTTP：`player_play_url` 不行，fallback `player_play_music` 成功（X08C 属老固件分支）。
- **L2 `text_to_speech`（mibrain）在 X08C 上是哑接口**：三次 code 0（含切中文、音量 50、停流后等 3s），均无声。
- **L4 `play-text`（siid=3/aiid=1，`xiaomi.wifispeaker.x08c`）一次成功**。注意该型号 spec 的 action `in` 是 piid 引用数组（`[1]`），不是对象，解析 URN 取第 4 段才是动作名。
- `stop` 在该 ROM 上不可靠（code 0 但状态不清，position 冻住；补一条 `play` 反而能解开），播/TTS 穿插时要先停、等几秒、再查 `player_get_play_status` 确认。
- 最终分工：`--play` 播 HTTP 走 L2，`--tts2` 播报走 L4。

## 10. 最小权限与共享边界（实测）

- 私有扫码/账密体系无 scope：同 `sid` 下账号全量可见。官方 OAuth2 有 `scope` 参数（`miot_cloud.py:128 gen_auth_url`，开放数据接口权限 ID），但官方集成自己都没传，且 scope 是接口分组级、非设备级，`client_id` 需小米签发——实践中都是 all-or-nothing。
- 可行的最小权限：robot 子账号 + 米家 App 只共享目标音箱。子账号视角实测：
  - L2 小爱云 `device_list`（master=0/1）为空——不认共享：`--play` 播 HTTP、`conversation` 回读不可用；
  - L3 `/home/device_list` 可见共享设备（`shareFlag=1, adminFlag=0, permitLevel=4`）；
  - L4 `play-text`（siid=3/aiid=1）子账号下发成功并出声。
- 能力矩阵（子账号）：TTS ✅，播 HTTP ❌，ASR 回读 ❌。播报型场景可最小权限，问答/播音场景需全权账号或走官方技能。

### 附：小爱与米家像两个团队（证据链）

- 两套 ID 空间：小爱 `deviceID`（UUID）vs 米家 `did`（数字），靠小爱 `device_list` 的 `miotDID` 字段硬桥接。
- 三套票据：`sid=micoapi`（小爱云）、`sid=xiaomiio/mijia`（米家云）、OAuth `access_token`（官方 HA/miloco，走 `oauth2` + MQTT），互不认。
- 共享只活在米家域：`shareFlag/permitLevel/adminFlag/owner` 都是 `/home/device_list` 的字段；小爱 `device_list` 无共享概念（仅 `master=0/1`），子账号查出空表是符合其语义的，不是 bug。
- 打通点在 miot 语义层：`play-text`（siid=3/aiid=1）是米家物模型对音箱的抽象，共享权限下放到了 action 级；媒体播放（ubus）与对话记录仍留在小爱私有域。
- 结论：米家分享的权限语义出米家域即失效。PoC 保持裸 API（失败即抛整包，不封装），以便继续验证边界。
