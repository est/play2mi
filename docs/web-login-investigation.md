# 小爱云（mina）浏览器侧登录调研报告

日期：2026-10-11　范围：`web/src`（书签版）登录链路　依据：本仓库 `docs/`、`cli/mi_auth.py`、本日多轮真机实验（Playwright 驾驶 Microsoft Edge，无中间层）

> 2026-10-11 深夜 **重大勘误**：本报告旧版的"票的类别 / User-Agent"结论**错误**。真正根因是 **JavaScript 大整数精度丢失**（见 §3）。已修复并在真浏览器验证通过（§5）。

---

## 1. 一句话结论

**卡死点只有一个：`account.xiaomi.com/pass/serviceLogin` 返回的 `nonce` 是 19 位大整数（> `Number.MAX_SAFE_INTEGER` ≈ 9e15），JS 的 `JSON.parse` 会把它解析成丢精度的 `Number`，导致 `clientSign = base64(sha1("nonce=" + 错值 + "&" + ssecurity))` 签错，`api2.mina.mi.com/sts` 恒定 401。**

- Python（任意精度整数）→ 每次都对 → CLI 必成；
- JS（`Number` 双精度）→ 每次都错 → 浏览器/node/任何 JS 必败。

**这与 User-Agent、票"形状"、`pass_ua`、`Connection`、HTTP/1.1 vs 2、CORS、TLS 指纹全都无关**（这些是排查过程中被限流和"一次性 auth"污染出来的假象，见 §7 勘误）。

---

## 2. 链路背景（我们到底在换什么）

```
① serviceLogin?sid=mijia&_json=true  →  code≠0 + location(router URL)
② GET {location} & _qrsize=240&_dc=…  →  { qr, loginUrl, lp }
③ 用户用【米家 APP】扫码 → GET {lp}（长轮询）  →  { userId, passToken, ssecurity, nonce… }
④ GET {lp.location}                    →  （回调落 cookie，mijia 域）
⑤ serviceLogin?sid=micoapi&_json=true  →  code=0 + nonce + ssecurity + location(/sts?)
⑥ GET {location}&clientSign=base64(sha1("nonce={n}&{ssecurity}"))
                                        →  Set-Cookie serviceToken on .mina.mi.com ✓
```

**要点：`/sts` 的 `auth`/`location` 是一次性的**——同一个 URL 兑换成功后，再兑换必然 401。排查时务必每次重新 `serviceLogin` 取新 location，否则会把"一次性"误判成"指纹/风控"。

---

## 3. 根因证据（逐步重放定位）

以 CLI 为基准，给每个 `HTTPSConnection.send` 打原始字节，并**实时**用 node 重放同一请求对比（`cli_live.py` + `replay_one.mjs`）：

```
[STEP] GET /pass/serviceLogin?sid=micoapi   node=200   CLI=200
[STEP] GET /sts?…                           node=200 token   CLI=401   ← DIVERGENCE
```

因为 node 是**先发**的：node 能兑换（200），CLI 反而 401 —— 直接暴露两个事实：
1. `/sts` 一次性（谁先兑换谁赢）；
2. **node 能拿 `/sts`，只要那张 `auth` 是"正确的签名"**。

进一步 2×2 隔离（谁签发/谁兑换，交替跑 6 次，排除顺序）：

| 签发 | 兑换 | 结果 |
|---|---|---|
| Python | node | **200 token ✓** |
| Python | Python | 200 |
| node | node | **401** |
| node | Python | **401**（连 Python 都救不了 node 签发的 auth） |

→ 问题**百分之百在 `serviceLogin` 那一步的 JS 解析**。直接对拍：

```
raw nonce     = 2818502318476480512
JS JSON.parse = 2818502318476480500     ← 丢了精度（不相等）

用【原始字符串 nonce】签名  → /sts = 200 token ✓
用【JSON.parse Number nonce】签名 → /sts = 401
```

**实锤。**

---

## 4. 修复

`web/src/core.js` 的 `stripXiaomi`：先把 ≥15 位的整数字面量包裹成字符串再 `JSON.parse`。

```js
function stripXiaomi(text) {
  const s = String(text).replace("&&&START&&&", "");
  // nonce 是 >2^53 的大整数，JSON.parse 会丢精度 → clientSign 签错 → /sts 401
  const safe = s.replace(/:(\d{15,})(?=[,}\]\s]|$)/g, ':"$1"');
  return JSON.parse(safe);
}
```

回归测试已加入 `web/dev/smoke.mjs`：
```js
const bigNonce = C.stripXiaomi('&&&START&&&{"code":0,"nonce":2818502318476480512,"ssecurity":"x"}');
assert.equal(typeof bigNonce.nonce, "string");
assert.equal(bigNonce.nonce, "2818502318476480512");
```

---

## 5. 验证（真机）

- `node dev/smoke.mjs` → ✅ 全过（含大整数回归）
- `node build.js` → ✅ 构建通过
- **真浏览器（Microsoft Edge，默认 HTTP/2，无需扫码，用 CLI 新鲜票）**：
  ```
  serviceLogin → 正确 clientSign → /sts = 200
  mina cookies: serviceToken,userId,micoapi_slh,micoapi_ph
  device_list = 200 {"code":0,"message":"Success","data":[{"deviceID":"863ff3af-…",…}]}
  ```
- **完整单页端到端（真扫码，干净浏览器上下文）**：
  `account 域 loginMina → 扫码 → 清 pass_ua → serviceLogin(micoapi) → clientSign → 顶层导航 /sts`
  → 落 `.mina.mi.com` 的 `serviceToken/userId/micoapi_slh/micoapi_ph` → `device_list = 200`。
  → **纯前端浏览器登录成功（不需要两段式/服务器）。**

---

## 6. 其他已验证的硬约束（决定实现）

1. **`pass_ua=web` 会让 `serviceLogin(micoapi)` 不返回 `nonce/ssecurity`**（无 App 形）。必须在 **account 域内**用 `document.cookie` 清掉 `pass_ua` 等链路 cookie，才拿得到 nonce。
2. **`/sts` 必须用【顶层导航】落 cookie**：登录页在 `account.xiaomi.com`，而 `/sts` 在 `api2.mina.mi.com`，跨域 `fetch` 会被 CORS 拦（`net::ERR_FAILED`，cookie 也不落），`<img>` 也不行；只有 `location.assign(stsUrl)` 让浏览器原生跟随，`Set-Cookie` 才会落到 `.mina.mi.com`。
3. nonce 是 >2^53 大整数（§3）。
4. 服务端对高频 `serviceLogin`/`/sts` 有限流：短时间内大量请求会 `70016`（连有效票也拒），冷却后恢复。

**最终单页设计**（已验证端到端）：登录页在 `account.xiaomi.com` → 扫码 → 清 `pass_ua` → `serviceLogin(micoapi)` → 大整数安全解析 → 正确 `clientSign` → **顶层导航** `/sts` → `serviceToken` 落 `.mina.mi.com` → 控制台页切回时自动 `probe()`（`main.js` 的 focus 兜底）。全程单页、无两段式、无服务器。

---

## 7. 勘误：旧版报告的错误结论（已作废）

| 旧结论 | 实际 |
|---|---|
| 票分"App 形 / Web 形"，`/sts` 只认 App 形 | 票无此区分；`/sts` 只认签名，签名错就 401 |
| 形状由发请求的 User-Agent 决定 | 与 UA 无关 |
| 浏览器拿不到 App 形票 | 浏览器能拿到；JS 只是把 `nonce` 算错了 |
| `/sts` 恒定 401 是像素级身份绑定 | 是 `clientSign` 里 `nonce` 精度丢失 |

排查中出现的"改任意 header 就 401 / TLS 指纹 / Connection: close / http2"等结论，均为 **`/sts` 一次性 + 服务端限流**造成的假象，不成立。

---

## 8. 复现/环境注意

- 本机 shell 里存在 `https_proxy=https://`（机房 IP）。**Python `urllib` 会走它并 `RemoteDisconnected`；node/浏览器不走**。跑 CLI 时请 `env -u https_proxy -u http_proxy …`。
- passToken **每次登录轮换**（前缀相同、后缀不同）；旧票会 `70016`，别拿旧票对比。
- 实验脚本（`cli_live.py` / `replay_one.mjs` / `fix_test.mjs` / `browser_verify_fix.mjs` 等）在 opencode 沙盒目录，未入库。
