# 小爱云（mina）浏览器侧登录：新流程设计说明

日期：2026-10-11　范围：`web/src`（书签版）登录链路
对照：`docs/web-login-investigation.md`（根因调研）、`cli/mi_auth.py`（Python 基准）
真机验证：Playwright 驾驶 Microsoft Edge，干净上下文，真扫码，端到端通过（见 §5）

---

## 1. 一句话概括

新流程 = **书签在 `account.xiaomi.com` 域上自己完成**「米家 APP 扫码 → 免密换 `sid=micoapi` 票」，
全程**同源、无服务器、无 token 中继**；换票的最后一步用**顶层导航**到 `/sts`，让浏览器原生跟随跳转链，
把 `serviceToken` 以 `Set-Cookie` 落到 `.mina.mi.com`。

与旧设计的根本区别：**从「借官方登录页、自己无法自定义换票」变成「自己扫码 + 自己算 `clientSign` + 顶层导航兑换」**。

---

## 2. 新流程全图（Playwright 真机抓包）

两个执行环境（都是书签注入 `init.js` 后由 `main.js` 按域名分派）：

| 环境 | 域名 | 分支 | 面板 |
|---|---|---|---|
| 控制台 | `api2.mina.mi.com` | `setupMina` | 设备 / 播放 / TTS / 音量 / 状态 |
| 登录页 | `account.xiaomi.com` | `setupAccount` | 二维码 + 运行日志 |

```
[控制台页] api2.mina.mi.com
 0. 注入 init.js                      → main.js 命中 mina 域 → 建面板 → probe
    GET /admin/v2/device_list         → 401（未登录）→ 切到「需要登录」视图
    点「🔐 去扫码登录」→ window.open 打开 LOGIN_PAGE
      = account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true（不会自动跳转，见 §3.8）

[登录页] account.xiaomi.com
 1. 注入 init.js                      → main.js 命中 account 域 → setupAccount → runLogin
 2. GET /pass/serviceLogin?sid=mijia&_json=true               → 200（code≠0 + location）
 3. GET /longPolling/loginUrl?…（取 location 的 query 当参数） → 200（qr / loginUrl / lp）
    渲染官方二维码（qr 图；缺图则用 qrserver 按 loginUrl 现场渲染）
 4. 米家 APP 扫码 → GET {lp}（长轮询，150s/次，最多 5 次）     → 200（userId/passToken/ssecurity/nonce）
    <img> 触发回调 GET sts.api.mijia.tech/mijia/sts?…         → 200（尽力而为，非必须）
 5. GET /pass/serviceLogin?sid=micoapi&_json=true             → 200（nonce + ssecurity + location）
    clientSign = base64(sha1("nonce={n}&{ssecurity}"))
 6. 顶层导航 GET {location}&clientSign=…                       → 200
    → Set-Cookie: serviceToken/userId/micoapi_slh/micoapi_ph 落 .mina.mi.com

[控制台页] 切回（focus 兜底）或收到 postMessage
 7. probe → GET /admin/v2/device_list  → 200 → 主面板
```

要点：**没有一步把票从登录页“传给”控制台页**。控制台页只是凭浏览器已种好的 `.mina.mi.com` 隐式 Cookie，
重新发一次 `device_list` 就成功了。

---

## 3. 关键设计点（每条都对应一个硬约束）

1. **同源执行模型**：书签是 `javascript:import('<host>/init.js?t='+Date.now())`，在**目标域自身的页面**里执行，
   所以对 `account.xiaomi.com` / `api2.mina.mi.com` 的请求都是同源，没有 CORS 读写障碍。
2. **无 token 中继 / 无服务器**：`passToken` 是 `.account.xiaomi.com` 的 `HttpOnly`，JS 读不到也写不了；
   `serviceToken` 由跳转链的 `Set-Cookie` 落到 `.mina.mi.com`。全流程只依赖浏览器原生 Cookie，不落地任何票据。
3. **大整数 nonce 安全解析**（`stripXiaomi`）：`nonce` 是 19 位大整数（> `Number.MAX_SAFE_INTEGER`），
   直接 `JSON.parse` 会丢精度导致 `clientSign` 签错、`/sts` 恒 401。解析前把 ≥15 位整数字面量包成字符串。
4. **清 web 链路 Cookie 拿「App 形」票**（`clearWebLinkCookies`）：请求带 `pass_ua=web` 时，
   `serviceLogin(micoapi)` 不返回 `nonce/ssecurity`，算不出 `clientSign`。必须先在 **account 域内**用
   `document.cookie` 清掉 `pass_ua` 等链路 cookie。
5. **`/sts` 必须顶层导航**（`navigate`）：`/sts` 在 `api2.mina.mi.com`，从 `account.xiaomi.com` 跨域 `fetch`
   会被 CORS 拦读、且**不会落 Cookie**；`<img>` 也不行。只有 `location.assign(stsUrl)` 让浏览器原生跟随，
   `Set-Cookie` 才会落到 `.mina.mi.com`——所以 `exchangeMicoapi` **没有返回值**，页面会跳到 `/sts`。
6. **登录完成回控制台的兜底**：登录页用 `<a target=_blank rel=noopener>` 打开，`opener` 为 `null`，
   `postMessage` 收不到。因此控制台页同时监听 `message` 与 `focus`，任一触发都重跑 `probe()`。
7. **域名后缀匹配分派**：小米登录链会把页面/请求落到子域（如 `account.xiaomi.com/fe/service/login`、
   `c3.lp.account.xiaomi.com`），精确 `origin`/`host` 相等会漏判。改用后缀匹配
   （`/(^|\.)account\.xiaomi.com$/`、`/(^|\.)mina\.mi.com$/`）。
8. **登录落地页必须「不会自动跳转」**：书签只能运行在**当前页面**，所以登录页必须停在 `account.xiaomi.com`
   上等用户点书签。直接开 `/pass/serviceLogin?sid=micoapi` 时，若浏览器已有有效 `passToken`，服务端会
   **瞬间 302 到 `api2.mina.mi.com/sts`（401）**，用户根本没机会点书签。改用
   `/pass/serviceLogin?sid=micoapi&_json=true`：服务端返回 JSON 文本、原地不动（未登录/已登录都稳定），
   `main.js` 注入后会清屏重绘成登录面板。未登录时 `qrLogin` 弹二维码；已登录时走 `already` 分支免扫码换票。
9. **登录页窗口句柄 + 自动关闭**：登录链接改用 `window.open(LOGIN_PAGE, "p2m_login")` 而非
   `target=_blank rel=noopener`，以便控制台页保留窗口句柄；`probe()` 成功后调用 `closeLoginWin()` 自动关掉
   登录标签页（也顺带让登录页的 `postMessage` 能到达控制台）。

---

## 4. 与旧设计的差异对照

| 维度 | 旧设计（v1.4 及更早） | 新设计（当前） |
|---|---|---|
| 登录由谁完成 | **不自己实现**，直接用小米官方登录页 `LOGIN_PAGE(sid=micoapi)`；该页回调即 `/sts`，浏览器自动落票 | 自己在 account 域实现 `sid=mijia` 扫码 + `sid=micoapi` 免密换票 |
| 取二维码 | 无（官方页面负责） | `serviceLogin(mijia)` → `longPolling/loginUrl` → 渲染官方 `qr` 图 |
| 换票方式 | 官方页面自动跳转 | 自己算 `clientSign`，**顶层导航** `/sts` |
| 票的流转 | 浏览器链路自动落 | 仍无中继，靠隐式 Cookie；额外要清 web 链路 cookie 才拿得到 `nonce` |
| 旧代码里的判断 | “account 域不返回 CORS，自定义扫码/换票在书签里做不到” | 该判断已被推翻：真正卡点是大整数精度（见 §5 时间线） |
| 域分派 | 精确 `location.origin === ACCOUNT_ORIGIN` / `location.host === MINA_HOST` | 域名后缀匹配，容忍子域 |
| 登录落地页 | `/pass/serviceLogin?sid=micoapi`：已登录时会瞬间跳 `/sts`(401)，用户没机会点书签 | `/pass/serviceLogin?sid=micoapi&_json=true`：原地不动，稳定可点书签 |
| 登录页窗口 | `<a target=_blank rel=noopener>`：无句柄、`postMessage` 收不到 | `window.open(…,"p2m_login")` 保留句柄，`probe()` 成功后自动关闭 |

**演进中的中间态（v1.5）**：`exchangeMicoapi` 曾用**跨域 `fetch`** 去请求 `/sts`，
结果“读不到响应、Cookie 也不落”，被视为“登录 blocked”。后来发现并修正了两点才成为今天的新设计：
`stripXiaomi` 的大整数修复 + `/sts` 改**顶层导航**。

---

## 5. 演进时间线（git）

| 提交 | 变化 |
|---|---|
| （更早） | 登录直接借官方登录页，代码不实现扫码/换票 |
| `351ca58 v1.5 login` | 首次在 `core.js` 自己实现 `qrLogin` + `exchangeMicoapi`（当时 `exchangeMicoapi` 用跨域 fetch 打 `/sts`） |
| `5c67a99 login blocked` | 误判“纯浏览器不可行”（票形状 / UA 理论），补 `docs/web-login-investigation.md` 旧版 |
| `ead692b fix nonce shit` | **找到真因**：JS 大整数精度 → `stripXiaomi` 保字符串；`/sts` 改顶层导航；新增 `clearWebLinkCookies` |
| `a978a5b v1.6` | 收尾 |
| `fc33fd6 check again` | 域分派放宽为后缀匹配（容忍 `fe.` / `c3.lp.` 等子域） |

> 详细根因与实验过程见 `docs/web-login-investigation.md`。

---

## 6. 验证（本次 Playwright 真机，端到端）

干净浏览器上下文（无任何票）→ 强制走扫码，结果：

```
步骤 0  console 页注入 init.js → login 视图            device_list 401
步骤 1  点「去扫码登录」→ account.xiaomi.com          /fe/service/login?sid=micoapi…
步骤 2  account 页注入 init.js → serviceLogin(mijia)   200
步骤 3  longPolling/loginUrl                          200（qr/loginUrl/lp 都有）
步骤 4  扫码（~19s）→ ak.lp.account.xiaomi.com/lp/s   200（userId/passToken/ssecurity/nonce）
步骤 5  sts.api.mijia.tech/mijia/sts（<img> 回调）    200
步骤 6  serviceLogin(micoapi) → clientSign → 顶层导航 /sts  200
步骤 7  .mina.mi.com cookie = serviceToken,userId,micoapi_slh,micoapi_ph
步骤 8  device_list                                   200，3 台设备 → 控制台回到主面板
```

补充：`node dev/smoke.mjs` 覆盖了 QR 端点回归与 `stripXiaomi` 大整数回归；
线上托管产物 `init.js` 已含 `fc33fd6` 的后缀匹配改动。

---

## 7. 注意事项 / 已知问题

- **限流**：短时间高频 `serviceLogin` / `/sts` 会被限流（`code=70016`，连有效票也拒），冷却后恢复。
- **二维码时效**：二维码生成后需尽快扫；拖太久会过期，长轮询会一直等到超时才重挂（5 次约 12 分钟）。
- **后台标签计时器节流**：登录页若失焦，`AbortSignal.timeout` 可能被节流不触发；端到端脚本里已用
  `--disable-background-timer-throttling` 规避（仅测试脚本需要，正式书签环境无此问题）。
- **`showRaw` 选择器大小写 bug（本次 e2e 发现，已修）**：`data: { rawBody: "" }` 经 `dataset` 会落成属性
  `data-raw-body`（camelCase→kebab-case），而 `q.rawBody` 选择器写成了 `[data-rawbody=""]`（全小写无连字符），
  **永远匹配不到** → 每次 `showRaw()`（TTS 下发成功、读状态成功）都抛
  `Cannot set properties of null (setting 'textContent')`，被 `act` / `refreshStatus` 的 `catch` 记成“失败”。
  已把选择器改为 `[data-raw-body=""]`，并给 `showRaw` 加了空值兜底。
  （教训：`el()` 的 `data:{...}` 会走 `dataset`，camelCase 键对应的属性是 kebab-case。）
- **「已登录但 mina 无票」场景**：浏览器有 `passToken` 但 `.mina.mi.com` 没 `serviceToken` 时，`device_list` 仍 401；
  此时走登录页会命中 `qrLogin` 的 `already` 分支（`serviceLogin(mijia)` 返回 `code=0`），**免扫码**直接换票。
  旧落地页在这个场景会瞬间跳 `/sts` 导致用户点不到书签，现已用 `&_json=true` 修掉。
- **备用播报**：面板新增「🔊 播报②」= `mibrain.ai_tts_request {tts_text, show_ui}`（`Mina.aiTts`），
  用于某些机型 `text_to_speech` 是“哑接口”（code 0 但无声）时兜底。同域、无需第三执行域/签名；
  是否真能出声待真机验证（依据 `docs/ubus-fields-and-lx04-shell.md §2.4`、`docs/shell-hunt-lx04-notes.md`）。
