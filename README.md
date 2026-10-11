# play2mi

stream your $url music on xiaomi smart speakers


## features

- No user/password login. Scan with your Mi Home qr-code. 不需要账号密码登录，通过 米家 app扫码
- No OTP, no SMS, 不需要 两步验证
- No client download nor install 不需要下载 和安装 客户端
- Speaks directly to `mi.com` API. No third-parties 直通官方API，不绕第三方服务器
- xiaomi API would block access from IDC IPs. 避免机房IP触发小米API风控  yihong0618/xiaogpt#240

## Known issues


- **全量设备风险** 之前考虑到大部分人米家绑定很多设备，扫码登录意味着所有设备都可以控制，迄今未发现单独设备授权机制。
  - 尝试了下把小爱音箱单独分享给一个专用账号，发现有些 API 调不通。
  - 我只记得 TTS 是可以用的，具体哪些不通？前面忘了，中间忘了，后面忘了，反正AI 说的不行 🤣
  - 当前版本暂时只考虑主账号（L2）下的设备，分享账号（L4/miot）待后续有缘人折腾
- - 部分老型号新固件不走 `player_play_url`，已内置型号表 + 运行时 fallback（对照 python 版）。
- 暂停按钮对不支持 action 的型号会在第一次探测后提示"用停止"。
- `text_to_speech` 在某些"哑巴"机型无声，跟 L2 协议 有关。L4 play-text 需要第三个
  执行域（`api.io.mi.com`），架构允许，但暂未实现。


## CLI 命令行

就两个文件，自己玩。我懒得写了 😆

## Web version notes

### 功能划分

- **core.js** 小米云协议核心
- **main.js** 入口与界面

若日后规模变大：
 - core.js 可按 `登录流程` / `Mina 客户端` 两块拆分。
 - build.js 的拼接列表加一行即可
 - 保证只内联，不破坏原始可读性，不编译。避免太多 .js 文件


## 构建

```bash
cd web
node build.js        # 拼接 dist/p2m.js + 拷贝 dist/index.html
node dev/smoke.mjs   # 冒烟（其实没啥测的。AI搞的形式）
```

产物在 `web/dist/`：`p2m.js`（协议+UI，可读未压缩）与 `index.html`（指南页）。


`web/dist/` 已 gitignore、不入库，由 Github Pages 自动构建

## 隐私

隐私信息全在本地浏览器（`.mi.com` 域 Cookie，passToken 为 HttpOnly）

本仓库无任何服务器参与运行期数据流。登出请在 account.xiaomi.com 手动退出。


## reference

- https://github.com/yihong0618/xiaogpt
- https://github.com/Do1e/mijia-api
- https://github.com/cherezov/dlnap/
- https://github.com/duhow/xiaoai-patch/blob/master/research/updates.md
- https://cdn.cnbj1.fds.api.mi-img.com/xiaoqiang/rom/lx01/mico_firmware_4215788a8_1.62.6.bin
- 
- https://github.com/birdsofsummer/xiaoai-crack
