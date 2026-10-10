# 小爱音箱 shell 复活研究：结论、经历与后来者线索

> 2026-10-10 一天实战的完整记录。设备：LX04（小爱触屏音箱，romVersion 2.42.118，
> 局域网 IP 192.168.31.146）。对照固件：LX01（Linux/OpenWrt 架构，mico_firmware 1.62.6）。
> 面向想接着挖的人：所有工具脚本、取证位置、下一步线索都在文中标出。

## TL;DR

一句话结论：**在 2.40+ Android 架构的 LX04 上，"改个怪异名字 → 弹 root shell" 的路没有跑通；
LX01 那套 Linux/OpenWrt 固件里确实存在一条真实的 root RCE 链（`tts_play.sh '%s'` 单引号逃逸），
但它的触发依赖云端通知通道，且在 LX04 上根本不存在这个 sink。**

具体要点：

1. `play_music_url` 信封内真正起作用的只有 `stream.url`；`audio_id`/`cp{...}`/`list_params`
   全是伪装"小微歌单"的占位符（首现于 `MiService@8fb49ee`，抓包复刻，非官方下发）。
2. LX01 固件静态审计定位出一个无过滤的 RCE sink：`mico-helper` 用 `pipe_exe`
   （`vsnprintf → popen`，无任何转义）执行 `/usr/sbin/tts_play.sh '%s' &`，
   文本里带 `'` 即可逃逸，root 运行。**未动态验证**（云端 path `notify` 被 400 拒）。
3. LX04 是 Android（MT8167），mico 原生 daemon 全被替换成 `MicoLauncher.apk` 里的 Java 实现。
   Java 层最有价值的能力：**静默文本语音指令** ——
   `mibrain.ai_service {"for_test":true,"nlp_execute":true,"nlp_text":"..."}` 实测 code 0，
   等价于替你对音箱说话（非 shell）。
4. 云端 `/remote/ubus` 网关有双层过滤：**path 白名单** + 对部分方法的**参数枚举校验**。
   `tts_vendor_switch.vendor_name` 的 5 种注入试纸全部被云端拦死（code 101 且无 device_data）。

---

## 一、经历时间线（这样挖出来的）

### 1. 摸清字段语义（不是抄配置，是抠固件）

先问的是"`play_music_url` 那一堆定义怎么用"。三方库（`thirdparty/MiService/miservice/minaservice.py`）
是显著的同源；但要回答"还有哪些字段、每个怎么用"，只能上固件。

### 2. 解开 LX01 固件（Linux/OpenWrt 完整 rootfs）

```sh
binwalk thirdparty/mico_firmware_4215788a8_1.62.6.bin
# → uImage kernel @0x5D88 (OpenWrt 3.4.39 ARM)
# → squashfs 4.0 (xz)  @0x4003C8, 26621017 bytes

dd if=fw.bin of=rootfs.sqsh bs=1 skip=4195272 status=none
unsquashfs -d rootfs rootfs.sqsh   # 65 个 .sh、70+ 个 mico 二进制
```

关键辅助：老 macOS 无 binwalk/squashfs-tools/rizin，全部在 OrbStack 的 ubuntu（linux/arm64）
里 `apt-get install binwalk squashfs-tools e2fsprogs`。分析脚本用 `python3 + capstone + pyelftools`
（`pip install capstone pyelftools`）。固件里的 rootfs 是 musl + 无 section-header 的 ARM ELF，
标准工具链都不友好，所以自写了下面几个小脚本（都在 `work-fw/`）：

| 脚本 | 用途 |
|---|---|
| `walktbl.py` / `runs.py` | 扫 ELF 找 stride-24 的 `{name,handler,z1,z2,policy,cnt}` 连续 run → **自动抠出 ubus 对象的完整方法表 + policy（参数+类型）** |
| `xref3.py` | 无 section-header 的 musl ARM ELF 里做 **LDR-literal 字面量池交叉引用**（linear-sweep + 编码级 pattern-match） |
| `pltx.py` / `plt.py` | 解 musl ARM **PLT stub**（`add ip,pc,rot / add ip,ip,rot / ldr pc,[ip,#-imm]!` 三元组），用 JMPREL/dynsym 还原出 `system`/`popen` 等 import 及其 stub VA |
| `bl2stub.py` / `blstr.py` | 找 **bl → system/popen stub** 的调用点，回溯参数寄存器的字符串加载，标注 `%s` + shell 语法的模板 |
| `dwin.py` / `disas.py` | 带字面量池注释的反汇编窗口工具 |

这套组合自产了 LX01 固件里 `mediaplayer` 对象的**完整方法+policy 全表**（28 个方法，含每方法的
参数名单和 blobmsg 类型），见 §四。

### 3. 静态审计发现：LX01 上唯一确定的 root RCE sink

`usr/bin/mico-helper`（自启 S70，procd root，`respawn 3600 5 0`）里藏着一个 fmt 模板：

```
/usr/sbin/tts_play.sh '%s' &          # 文件偏移 0x4e07
```

- `mico-helper` 用 **`pipe_exe`**（出自 `libmico-common.so`，`vsnprintf → popen("r") → /bin/sh`）
  执行它；整条链**没有任何 shell/JSON 转义**——通知文本里的 `'` 直接闭合单引号。
- 输入源：ubus 对象 `notify` 的 `create` 方法（policy：`id, level, expire, volume, text`），
  通知文案写进 `/data/notify/<id>`；到点播放时走 `tts_play.sh`，文本注入 shell。
- `usr/sbin/tts_play.sh` 内部还把同一个文本拼进 `ubus call mibrain text_to_speech "{\"text\":\"$1\"...}"` ——
  **双 sink**（shell 逃逸 + JSON 字段注入）。
- 邻居 `etc/init.d/dropbear`：门控文件 `/data/ssh_en`/`/data/.ssh_en`/`/tmp/ssh_en` 任一为 1 即开 SSH。
  也就是说：**一旦 shell 已达，用 `echo 1 > /data/ssh_en` 即固化局域网 root SSH**。

**为什么没实际打成**：云端 `remote/ubus` 对象 `notify` 被 400 拒（见 §三），而 LX04 是 Android 架构
（§五）没有这个栈。这条链只在 LX01 类 Linux 型号上真存在。

### 4. 云端可达性探测（这一步把所有路重新洗牌）

写了个逐 path 探测脚本 `work-fw/probe_paths.py`：对每个候选 path 发一个不存在的方法
`nosuchmethod_poc`，看能不能非 400 穿透。结果：

| path | 云端 /remote/ubus | 设备端 |
|---|---|---|
| **mediaplayer** | ✅ 全方法转发（含任意字符串 message） | ✅ 由 MicoLauncher Java 接 |
| **mibrain** | ✅ 全方法转发 | ✅ Java handler（见 §六） |
| mibt / miio / mode_manager / voip / power / alarm | ✅ 转发 | 多数对象不存在 → `code 900 "ubus error"` |
| dlna / qplayer / linein / aux / bt / pns / **notify** / usb_audio / led / … | ❌ 400 | — |

### 5. "试纸实验"：定位云端参数校验

对 `mibrain.tts_vendor_switch`（policy: `vendor_name, language_name, switch_src, dialog_id, tone_type`）
送了 5 种"温柔注入"变体：`XiaoMi'` / `XiaoMi;` / `" XiaoMi"` / `XiaoMi反引号` / `XiaoMi$(reboot)`。
全部返回 `code=101` 且 **无 device_data 字段**。

关键在于**错误形状本身**：正常设备端错误会带 `device_data: {"code":900,...}` 或超时 `3012`；
无 device_data 说明**请求根本没到音箱** → 推定云端 `/remote/ubus` 对这个方法的参数做了**枚举校验**
（很可能就是 `tts_vendor_show` 返回的那 4 个音色名）。

同一方法良性值（`Default` / `XiaoMi`）回 `code 0`，但**没有实际声音/灯效**——
说明良性路径确实打通到设备，只是音色切换在 LX04 上是"Java 资源后缀切换"（§六），无 shell 痕迹。

### 6. LX04 = Android：架构完全不同

`thirdparty/lx04_fw/payload_2.40.11_4023a.bin` 是 **Android OTA payload**（magic `CrAU`，
内含 odmdtbo / tee / vendor / boot / system / lk / preloader 分区）：

```sh
payload-dumper-go -l  payload.bin    # 列分区
payload-dumper-go -o images payload.bin
debugfs  -R "rdump /system sysroot"  images/system.img   # 940MB ext4 整树导出
```

JADX 反编译 `MicoLauncher.apk`（56MB，6 dex）后，结论：

- **`com/xiaomi/micolauncher/common/ubus/handlers/MiBrainUbusHandler.java`** —— mibrain ubus 全方法：
  - `tts_vendor_switch` → `ToneType.valueOf(vendorName)`，值域= 
    `Default(AiNiRobot) / XiaoMi / XiaoMi_M88 / XiaoMi_xinran`（`SoundToneManager.java` enum），非法值
    `IllegalArgumentException` → 兜底 Default。**切音色 = 换 `R.raw.*` 资源后缀，无 shell。**
  - `ai_tts_request {tts_text, show_ui}` → `SpeechManager.ttsRequest`（任意 TTS 播报）。
  - **`ai_service {for_test, nlp_execute, nlp, tts, nlp_text, uuid}`** → `SpeechManager.nlpRequest /
    nlpTtsRequest`（任意"文本语音指令"直达 NLP）。mic-mute 时若不带 `for_test:true` 直接 `MuteResponse`。
    **实测 code 0** ——这就是"替你说话"通道。
- `Runtime.getRuntime().exec(...)` 全 decompile 后仅 5 处，全部**固定字符串**或 int 拼接：
  `logcat -d -v time` / `logcat -d -f <file>` / `getprop <prop>` / `input keyevent <int>` /
  `ping -c 1 -w 5 <host>`。第 5 处（`MiTvOpenTest`）host 来源于 DLNA SSDP 发现的
  `baseURL.getHost()`——URL 解析天然剥掉空格/引号，注入不成立。
- 所有 native libs（`libmiio_linux.so`/`libaivs_jni.so`/`libmibrainsdk.so`/`libidmtrans.so`/…）
  grep 无一处 `system()/popen()` 字符串模板可达。LX01 那套 **mico daemon 栈在 LX04 里彻底消失**。

## 二、结论表

### LX01（Linux/OpenWrt 1.62.6）静态定位的注入 sink 与成功被拦的位置

| 发现 | 位置 | 状态 |
|---|---|---|
| `tts_play.sh '%s' &` 单引号逃逸 root RCE（pipe_exe 无转义） | `mico-helper` 0x14038 | **真 bug，未动态打**（云端 notify path 400） |
| `rm -rf /data/sound;ln -s /usr/share/sound-vendor/%s /data/sound` | `mibrain_service` 0x15f40/0x168cc | 静态见，动态侧云端已枚举拦 vendor_name |
| `mkdir /data/sound-vendor/%s` + `tar -zxvf audiofile.tar.gz -C /.../%s` | `mibrain_service` 0x163f8+ | 同上 |
| `ubus -S -t 1 call path_child_mode set '{"message":"{\"isChildMode\":%s}"}'` 拼 shell | `mico_aivs_lab` 0x564ac（引用点 0x46d8c） | 良性 true 请求 code 0，无响——**LX04 无此 handler**（LX01 才有） |
| `adbd` release 分支直接 return | `etc/init.d/adbd:11-13` | 拆不了 shell（release 固件无 adbd） |
| `dropbear` 门控 `/data/ssh_en` | `etc/init.d/dropbear:126-131` | 有 root 才能开门 |

### LX04（Android 2.42.118）实测结论

| 项 | 结论 |
|---|---|
| LAN TCP 1–1023 + 常用高端口 | 全关（无 ssh/adbd/httpd/dlna-renderer/upnp） |
| LAN UDP 54321 (miIO) | 无响应（hello 3 种格式均试） |
| OTA | LX01 上 `bin/ota` 主路径走明文 `http://api.miwifi.com/rs/grayupgrade`，但 `bin/flash.sh → miso -v` **RSA 验签**（`PEM_read_bio_PUBKEY / EVP_VerifyFinal`） |
| 云端 ubus 层 | path 白名单 + `tts_vendor_switch.vendor_name` 枚举校验 |
| 静默语音指令 | **`mibrain.ai_service`/miot spec `5.4 execute-text-directive` 实测 code 0**（非 shell） |

## 三、有趣的坑（后来者少走弯路）

1. **`.tmp` 是个软链接，指向 `/tmp`** —— 完全把你"别用 /tmp"的要求变成"必须用真实目录"。
   所有工件都落在 `work-fw/`（LX01）、`thirdparty/lx04_fw/`（LX04 dump）、`work-fw/spec/`（spec/插件）。`thirdparty/` 本身也软链到 `../campro/thirdparty`。
2. **Ubuntu 24.04 noble 没有打包 rizin/radare2/payload-dumper-go**——都只能走 Github release
   或 go install；`GOPROXY` 直连 github 又会被 DTLS/P 网络问题折磨。
   最后 payload-dumper-go 是从 `https://api.github.com/repos/ssut/payload-dumper-go/releases/latest`
   里查到正确 release 名（`2.1.0`，文件名 `payload-dumper-go_2.1.0_linux_arm64.tar.gz`）——
   **不要手猜 URL，一定先查 release API**。
3. **手算 musl ARM PLT stub 的 GOT 偏移**（`add ip,pc,rot / add ip,ip,rot / ldr pc,[ip,#-imm]!` 三元组）
   第一次算错了——GNU ld 生成的 stub 在第二、三条指令里有 `_GLOBAL_OFFSET_TABLE_` 加入的修正轮转。
   自写 `pltx.py` 按 ARM ARM 编码精确解 rot-immediate 就好办。
4. **capstone 5.x 遇到字面量池字跳字失败**（对齐 4 字节指令被 2 字节 val 池堵死）——
   直接用编码级 pattern-match（`0xEB.../0xEA...` bl 直跳 & `cond 011P U0W1` 的 ARM LDR-literal）
   比对齐 disasm 稳健得多。
5. **米家 App UA** `"MICO/iOSApp/appStore/6.0.103"` 是所有 mina 接口的通行证
   （`src/mi_auth.py` 已内建）。
6. **本地抓包 vs 云端分流**：`hanxi` 在 `hanxi/xiaomusic#49` 原话——"用 reqable 抓
   `com.xiaomi.mico` 抓到播放音乐用 `player_play_music`"——是这套字段生态的源头。
7. **`hass-xiaomi-miot#2918` 副作用**：设备会回显 `media_content_id=1582971365183456177`、
   `media_title="请欣赏 (音乐)"` —— 可当"播放成功 oracle"使用。
8. **`skip_controls` 只认字面量 `"NEXT"`/`"PREV"`** —— 想让音箱跳过广告，这块值得改成你的推客。
9. **`/data/etc/notify_%d.cfg`**（`mico-helper` 默认配置）notifications 分级、autoplay 可控——它就是
   上面 root RCE 的输入头。
10. LX01 官方 APK 里 `URLINSTRUCTION_PARA is %s` 的 debug 串 + `ubus -t 1 call %s %s ...` 模板
    （`mediaplayer` 0x16198 所在物）说明 App 内部就是用 ubus CLI 拼命令流 —— 云端网关的
    path 白名单基本就是把 **App 的白名单 = ROM 的白名单**。

## 四、一页纸：后来者的接线索清单（按优先级）

1. **[硬件] 拆机找 UART** —— 小爱音箱板上一般留有串口。`etc/inittab: /bin/login` 在 LX01 是底线；
   LX04 是 Android build（`boot.img` cmdline `buildvariant=user`）——能有 root console 就能 `echo 1 > /data/ssh_en` 直接固化 dropbear。
2. **[静态] 追 `alarmd`** 的 sqlite→awk 写文件链（`usr/bin/alarm_translate.sh:13-43`，`ID` 列做文件名，
   理论目录穿越写）。LX01 侧可行，`alarm` path 云端转发但设备端无对象（code 900）——但设备端方法表（alarm_create 12 个参数
   含 `display_txt`/`event`）顺着折腾或许有别的容器。
3. **[静态] 追 `mico_aivs_lab` 的 `CustomDirective` / `execute device skill directive: %s`+`count_down_start`**
   （`ns/ui_controller_ns.cc`、`ns/system_ns.cc`、`base/aivs_engine.cc` 一整族）——云端 skill payload 可能
   有未过滤 shell 面（LX01 独有栈）。
4. **[静态] 追 `messagingagent`** 的 push→ubus 级联（`/internal/ubus`、`create_ma_ubus_server`）——
   弄清"自家小米账号能不能给音箱发通知/指令"，就是 1.3 RCE 的 cloud-author 认证路。
5. **[Android] MicoVoip.apk (70MB) / MeshGateway / mqtt.service.application 拆包**——三者均有发生网络面
   可能与未来固件更新/云下发有关。
6. **[APK 层] `bin/adb_shell` `sh -c "$2"`** 是"设计如此"，只在 adb 里跑 ——
   能在 boot.img 上打解verity/eng 补丁，或解锁 bootloader → 全线打开。未研究签名。
7. **[协议] UDP 54321 miIO hello**（金格式）去试 LX04 是否仅是过滤了 hello，或有更远的 miIO LAN
   （`token` 认证的有 sh）。当前 lx04 上 UDP 无响应。
8. **[APK] AndroidManifest 解码正确姿势**：AXML 字符串池 flags≠UTF-8 → 我那边拿到乱码汉字，
   后续可用 `androguard` 或反射拿 exported receiver 名单（现在是空，但那只是解析 bad）。

## 五、关键文件与产物（现场考古可复现）

```
work-fw/                         LX01 固件解析（binwalk + squashfs）
  ├─ rootfs/                     完整 Linux rootfs（65 个 .sh）
  ├─ runs.py / xref3.py / pltx.py / blstr.py / dwin.py   分析工具链
  ├─ dis_*.txt                   反汇编片段（play_url/play_music/mibrain/handler…）
  ├─ fire.py / fire2.py          ubus 注入发射脚本（tts_vendor / tts vendor_body）
  ├─ probe_paths.py              云端 path 白名单探测
  ├─ probe_filter.py / probe_valid.py   试纸实验
  └─ notify_test.py              notify.create 良性测试（HTTP 400 证据）
work-fw/lx04/                    LX04 Android 固件解剖
  ├─ images/{system,vendor,boot,...}.img      payload-dumper-go 产物
  ├─ sysroot/system/...                       debugfs rdump /system 整树
  ├─ mica/{classes*.dex,lib/armeabi-v7a/*.so} MicoLauncher.apk 解包
  ├─ mica_jadx/sources/com/xiaomi/micolauncher/...    jadx decompiled
  ├─ libmibrainsdk.so             单独 dump 的库副本
  └─ jadx-*/                      jadx 1.4.7 runnable (需要 JDK17)
work-fw/spec/                    miot-spec LX04 v1/v2 JSON + 米家 RN 插件包
thirdparty/lx04_fw/              LX04 payload_2.40.11 原始 bin + README + 下载来源
```

## 六、与官方（小米）文档的对照（供接线索的人交叉验证）

无公开 Mina/ubus 文档；唯一"文档"是三方生态逆向：
- **代码逆向**：`Yonsm/MiService`（原始），`yihong0618/MiService`（活跃 fork，供 xiaogpt 使用）、
  `hanxi/xiaomusic`、`al-one/hass-xiaomi-miot`（HA 集成）。
- **固件 dump/逆向**：`birdsofsummer/xiaoai-crack`（ubus list mediaplayer 实机输出；
  player_play_music 签名 {music,startOffset,loadMoreOffset,media,src,id,duration}），
  `xuanxuanblingbling` 2022-09-16 补天杯复盘（wakeup.sh→player_play_url 实机命令）。
- 本仓库的固件静态分析与上述生态的字段完全互相印证。

---

## 七、文档（仓库内相关）

- `docs/ubus-fields-and-lx04-shell.md` —— 字段手册（面向"怎么用"），本文件是它的叙述版
- `docs/xiaomi-speaker-research.md` / `docs/xiaomi-mediaplayer-firmware.md` —— 背景调研
