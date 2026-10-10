# play2xiaomi · bookmarklet 版（web/）

**无服务器、不装程序的小爱音箱遥控器**：一个书签（bookmarklet）+ 一份静态托管页。
浏览器直连小米云接口——因为我们的界面就运行在小爱云自己的域名上，同源天然无 CORS。

> 架构核心：`javascript:import('https://…/p2x.js?t='+Date.now())`
> 在 `api2.mina.mi.com` / `account.xiaomi.com` 域内注入 UI；凭证是浏览器原生 Cookie
> （登录链路自动把 `serviceToken` 落到 `.mina.mi.com`）。没有 token 存储、没有后端。

## 目录结构

```
web/
  index.src.html    指南页模板（拖拽安装书签 + 使用教程）；build 时注入托管地址
  src/core.js       协议层（无 DOM）：扫码登录、免密换票、Mina 客户端、纯JS二维码
  src/main.js       界面层：入口分派（任意页面/mina/account 三环境）、面板 UI、登录编排
  dist/             构建产物（p2x.js + index.html），GitHub Pages 托管的就这两个文件
  build.js          纯拼接构建（不压缩、不转译、保留可读性）+ node --check 自检
  dev/smoke.mjs     零网络冒烟测试（拦截 fetch 验证请求构造）
  package.json      仅声明 type=module（给 node --check 用），零 dependencies
```

### 功能划分（给想加功能的人）

- **core.js 不碰 DOM**：它只是"小米云协议的忠实搬运"（对照 python 版
  `src/mi_auth.py` 与 `qr_mina_play.py` 的 Mina 部分）。加新 API 就在这里加方法，
  并顺手补 `dev/smoke.mjs` 的桩校验。
- **main.js 只管编排与界面**：入口分派逻辑见 `init()`；面板是纯构建的 overlay，
  关闭不打断播放；与登录弹窗的通信走 `postMessage`（origin 校验严格）。
- 若日后规模变大：core.js 可按 `QR 生成` / `登录流程` / `Mina 客户端` 三块拆分，
  build.js 的拼接列表加一行即可；或改用任意打包器输出单文件（目前的拼接是刻意选的）。

## 构建

```bash
cd web
node build.js --url https://你的用户名.github.io/play2xiaomi/p2x.js
node dev/smoke.mjs   # 冒烟（可选）
```

产物在 `web/dist/`：`p2x.js`（协议+UI，可读未压缩）与 `index.html`（指南页）。
**`web/dist/` 已 gitignore、不入库**，每次发布现场构建即可（见下）。

## 部署 GitHub Pages

仓库已带 `.github/workflows/pages.yml`：push 到 `main` 后会自动
`node build.js --url <你的 Pages 地址>` + 跑冒烟测试，并把 `web/dist/` 发布为站点根
（因此书签加载地址形如 `https://<owner>.github.io/<repo>/p2x.js`）。

1. 把仓库推上 GitHub，进入 Settings → Pages；
2. Source 选 **"GitHub Actions"**（工作流自带，无需分支/目录设置）；
3. 打开 `https://你的用户名.github.io/play2xiaomi/`，按指南拖拽安装书签。

不想用 Actions 也可以手动发布：本地 `node build.js --url <真实地址>` 后，把
`web/dist/` 里的两个文件上传到任意静态托管（jsDelivr 亦可：
`https://cdn.jsdelivr.net/gh/用户/仓库@分支/web/dist/p2x.js`，注意此时要改 build 的 URL）。

> 注意：书签以 `import()` 加载 `p2x.js`，模块加载需要 CORS 响应头。
> GitHub Pages 与 jsDelivr 均默认回 `Access-Control-Allow-Origin: *`，开箱可用。

## 使用流程

- **首次**：任意页面点书签 → 自动开控制台标签页 → 该页再点书签 → 面板提示登录 →
  弹窗（account.xiaomi.com）内再点书签 → 米家 APP 扫码 → 凭证落 Cookie → 自动回面板。
- **日常**：打开控制台标签页（或任意页面点书签聚焦它）→ 点书签开合面板。

## 已知边界

- 只支持**主账号**设备（子账号设备不在 L2 设备表，L4/miot 通道暂未计划）。
- 部分老型号新固件不走 `player_play_url`，已内置型号表 + 运行时 fallback（对照 python 版）。
- 暂停按钮对不支持 action 的型号会在第一次探测后提示"用停止"。
- `text_to_speech` 在某些"哑巴"机型无声——那是 L2 协议的已知短板，L4 play-text 需要第三个
  执行域（`api.io.mi.com`），架构允许但未实现。

## 隐私

票据全部在浏览器本地（`.mi.com` 域 Cookie，passToken 为 HttpOnly），本仓库无任何服务器
参与运行期数据流。登出请在 account.xiaomi.com 手动退出。
