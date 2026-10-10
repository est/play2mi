# 小爱云（mina）浏览器侧登录调研报告

日期：2026-10-11　范围：`web/src`（书签版）登录链路　依据：本仓库 `docs/`、`cli/mi_auth.py`、本日 14 组真机实验（Playwright 驾驶 Microsoft Edge v1.4x，无任何中间层）

---

## 1. 一句话结论

**卡死点只有一个：`api2.mina.mi.com/sts` 只认"App 形票"（响应里带 `nonce/ssecurity`、再用 `clientSign` 签名的那个）。
浏览器书签链路拿到的是"Web 形票"（响应里没有 `nonce/ssecurity`），打 `/sts` 恒定 401，`serviceToken` 永远落不到 `.mina.mi.com`。**
票的"形状"由**发起扫码登录那次请求的 User-Agent** 决定：MiHome/… → App 形；浏览器 UA → Web 形。
已验证：即便把 UA、票据、请求头全部扮成 App 客户端 / 或者清除 `pass_ua` 让响应短暂回到 App 形，小米在这条会话上的 **passToken 依旧被服务端绑成 Web 类**，`/sts` 依旧 401（§7 H1 全套实测）。
**→ 纯浏览器不可行。** 可行路径只剩：CLI 发票（本报告 §8，实测 `device_list code:0 devices:2`）或桌面端登录进程。

---

## 2. 小米链路背景（我们到底在换什么）

```
① serviceLogin?sid=mijia&_json=true  →  code≠0 + location(router URL)
② GET {location} & _qrsize=240&_dc=…  →  { qr, loginUrl, lp }   ← ② 就是楼下的 /longPolling/loginUrl
③ 用户用【米家 APP】扫码 → GET {lp}（长轮询）          →  { userId, passToken, ssecurity, nonce, deviceId… }
④ GET {lp.location}                                  →  （落 .account 域的 passToken 等）
⑤ serviceLogin?sid=micoapi&_json=true                →  code=0 + location(/sts?) 
⑥ GET {location}&clientSign=base64(sha1("nonce={n}&{ssecurity}"))
                                                     →  Set-Cookie serviceToken on .mina.mi.com ✓
```


---

## 3. 成功链路（Python CLI）—— 逐请求实测（本日 23:36 抓包）

请求头：`User-Agent: MiHome/6.0.103 (com.xiaomi.mihome; build:6.0.103.1; iOS 14.4.0) Alamofire/6.0.103 MICO/iOSApp/appStore/6.0.103`
请求头：`Cookie: deviceId=27NHZYTPZFQO8EYV; userId=265010269; passToken=V1:DX…; sdkVersion=3.9;`　← **只有这 4 件**

| # | URL | 响应要点 |
|---|---|---|
| ① | `account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true` | `code=0`，**`nonce=42614257`（有）**，`ssecurity=101+2NMowtg2（有）`，`location=https://api2.mina.mi.com/sts?d=27NHZY…&ticket=0&…&auth=…` |
| ② | `{location}&clientSign=base64(sha1("nonce=…&ssecurity"))` | **HTTP/2 200**；`set-cookie: serviceToken=sXE…； userId=…; domain=.mi.com； micoapi_slh=…; domain=.mi.com； micoapi_ph=…; domain=.mina.mi.com`，body `{"R":"","S":"OK"}` |

→ **`.mina.mi.com` 拿到 `serviceToken`，`device_list` 即可用。**
注：① 的响应头也会带 `Set-Cookie: pass_ua=web` 返回（服务器总是 sich）。**关键在请求里是否带 pass_ua**（见 §4）。

---

## 4. 失败链路（浏览器书签）—— 逐请求实测（diag7 / diag12 真机）

请求前 Cookie jar：`deviceId=QZ7M4Kc8RyXVwaT2`（我们自己预置的 App 形，**小米没改写**）、`passToken(H)`、`userId`、`cUserId`、`pass_ua=web`、`passInfo=login-end`、`ptn_count(H)`、`uLocale`、`theme`、`sdkVersion`。UA = Chromium 默认。

| # | URL | 结果 |
|---|---|---|
| ① | `serviceLogin?sid=mijia&_json=true` | 200，`code=70016`（=需要扫码，正常），给 location |
| ② | `longPolling/loginUrl?…&sid=mijia…` | 200，`qr` / `loginUrl` / `lp` 全有 |
| ③ | 米家 APP 扫码 → `GET {lp}` 长轮询 | 200，**返回 `userId/passToken/ssecurity/nonce/cUserId`** |
| ④ | `GET {lp.location}`（=`sts.api.mijia.tech/mijia/sts?d=QZ7M4Kc8RyXVwaT2&…auth=…`） | `<img>` 触发 → **HTTP 200**（此路径小米是放行的；它的 Cookie 落在 `.mijia.tech` 域，我们用不到） |
| ⑤ | `serviceLogin?sid=micoapi&_json=true` | 200，**`code=0` 但 `nonce=无 / ssecurity=无`**，`location` 直接是 `/sts?d=…&auth=…` |
| ⑥ | `GET {location}`（fetch / `<img>` / curl 全试过） | **HTTP 401**，`.mina.mi.com` 一个 cookie 都没落；`device_list` 仍旧 401 |

---

## 5. 差异逐条对照（带证据编号）

| 差异点 | Python 成功链 | 浏览器失败链 | 证据 |
|---|---|---|---|
| **D1. User-Agent** | `MiHome/6.0.103 (…MICO/iOSApp…)` | Chromium 默认（Edge/…) | diag10→70016、diag13（MiHome UA + 浏览器 jar）见 §7 |
| **D2. 请求是否带 `pass_ua=web`** | **不带**（显式 Cookie 只有 4 件） | 带（登录链自动加入，无法用 fetch 摘除） | 本报告 §3 步① vs §5 diag9 |
| **D3. ①响应形状** | `code=0 + nonce + ssecurity + location(/sts?)` | `code=0 + (无 nonce/ssecurity) + location(/sts)` | 本报告 §3 vs diag9/diag8 |
| **D4. 是否要带 `clientSign`** | ⑤⑥ 必带（sha1(nonce&ssecurity)） | 因 ① 无 nonce → **算不出来** | mi_auth.py:215-217 vs diag9 |
| **D5. Cookie 里的"link 形"票** | passToken 与 MINA 无绑定关系（四件套即可复用） | passToken 与 `pass_ua=web` 绑定：删 pass_ua → `code 70016` | diag10 |
| **D6. passToken 颁发者** | 由 `lp` 回调下发到 CLI 的 json（可直接当 header 用） | 只走 `Set-Cookie`(HttpOnly)，浏览器 JS 读不到 | mi_auth.py:196-202；diag7/10 |
| **D7. `/sts` 终点** | 接受（200） + 落 `serviceToken` | 401，无 set-cookie | 本报告 §3 步② vs diag13（MiHome UA+全部 jar 仍 401） |
| **D8. deviceId 形状** | `27NHZYTPZFQO8EYV`（大写随机） | 我们预置 `QZ7M4Kc8RyXVwaT2` 也没被覆盖；**但依旧 401** → 形状**不是**关键 | diag7/diag12 |

---

## 6. 已排除的假设（都试过了，别再绕回）

1. ~~`fetch` 的 CORS 是元凶~~ → diag13 用 curl 直接打 `/sts`（无 CORS）仍 401。CORS 只是**读不到响应**，不是 401 原因。
2. ~~`deviceId` 带 `wb_` 前缀导致票是"web 票"~~ → 预置 App 形 device（`QZ7M4Kc8RyXVwaT2`、`KK8RyXVwaT2m4QZ7M4`）后走过 `/sts` 仍 401（diag12）。
3. ~~`pass_ua` 删掉就能走 app 形~~ → 删掉后浏览器侧 `serviceLogin` 反而 `70016`（passToken 被链上其余 cookie 绑死）；diag10。
4. ~~Cookie 里有 `theme/uLocale/cUserId` 等干扰~~ → CLI 的四件套 + `pass_ua=web` 组合无论怎么排都拿到"无 nonce"形状（本报告 §5 D2/D3）。
5. ~~`sdkVersion` 缺失导致 70016~~ → 4 件套里包括它仍 70016（diag10/diag14）。
6. ~~交叉调用（app UA+浏览器票，浏览器 UA+app 票）~~ → app UA + **浏览器票** = `70016`（票与 UA 绑定，diag10）；浏览器 UA + **CLI 票** = 拿到 nonce（diag10 前置实验，等于 CLI 自身成功）。

---

## 7. H1（UA 全程）实测结果 —— 已关闭（2026-10-11 深夜补测）

做了三件事，每件都有数据：

1. **`fetch` 能否设置 `User-Agent` 头**：✅ 可以（httpbin 回读 = `MiHome/6.0.103…`）。实现层无障碍。
2. **MiHome UA 全程跑完扫码链**（platform级 `userAgent` 覆盖 → ①②③④ 与 CLI 完全同 UA）：全部成功，但发现的差异是——服务器**仍然**给这条会话发的是 `wb_8dad9641-…`（web 形）deviceId（diag15 日志 `d=wb_…`），**没有**接受我们预置的 App 形（diag12 同样被改写）。
3. **清掉 web 链路 Cookie（pass_ua 等 6 项）之后**：`serviceLogin(micoapi)` 竟然 **确实返回了 App 形**：`{code:0, nonce:true, ssec:true}`（diag15/diag16），说明"可用形状"的门槛就是那组链路 Cookie。
4. 但最后一步 `/sts` —— 无论用 `fetch`（CORS 挡读）还是 **顶层导航**（`Sec-Fetch-Mode: navigate`），`.mina.mi.com` 都**一个 Cookie 没落**；再用 **curl + 完整复刻**（MiHome UA / Sec-Fetch / Referer / Origin / 4件套 / +pass_ua / 换 App 形 device）**共 10 种组合全部 401**（diag16/diag17）。
5. 关键对照：同一时间窗、同一 curl 签名，**CLI 的 passToken** 能打出 200 + `set-cookie serviceToken`（前述 binary 复现），**浏览器链路签发的 passToken**（这个 `wb_…` 会话的）**一律 401**。

**结论：小米在"登录会话落地"的那一刻就决定了这个 passToken 的"客户端类别"，并把它与 `/sts` 的接受名单绑定。浏览器里无论 UA、票据、请求头怎么扮成 App 客户端，都换不到会话的"App 类"。该绑定点在服务端，浏览器无字段可探。**

→ **纯浏览器路径 A 已闭环、不可行。** 不要再在这上面投入。后续依赖：CLI 发票（本报告 §8 的 B）或其它（桌面端 CLI 进程）。

---

## 8. 可行路径总结（给决策）

| 路线 | 描述 | 代价 | 实测可信度 |
|---|---|---|---|
| **H1 纯浏览器 + MiHome-UA 全程** | 见 §6/§7；一次扫码实验 | 代码：UA 头注入 + 走 clientSign | **待验证**（若 `fetch` 不可设 UA 头 → 不可行） |
| **成功/退路：CLI 发票 + 浏览器种 Cookie** | CLI 已生成 `cli/mina_qr_auth.json`（含 `micoapiServiceToken`）。控制台面板一个粘贴框（或拖文件），页面用 `document.cookie` 种 `userId(.mi.com)+serviceToken(.mina.mi.com)` | 一次粘贴；无服务器；Cookie 2 个月 | ✅ **已实测**（diag6：`device_list code:0, devices=2`） |
| 维持 CLI 版 | 不做 web | — | ✅ |

---

## 9. 附：本轮相关的代码/实验文件位置

- 真机实验脚本一律在沙盒目录（opencode 临时目录）`…/opencode/edge-cloned/diag*.mjs`——**没有**进仓库，读完报告可删。
- 仓库里的代码已回退/校正到"手动 clientSign 流程"，包含两处**和这份结论一致**的修正：
  - `core.js`：`lp.location` 换成 `<img>` 触发 + 失败不中断（diag3 失败根因）；
  - `credentials: "include"`（跨域 Set-Cookie 必须带）。
- `web/dev/smoke.mjs` 保留了"step2 必须打 `/longPolling/loginUrl`"的回归断言。
