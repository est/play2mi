/* ============================================================================
 * play2xiaomi · core.js —— 协议层（无 DOM 依赖，可独立测试）
 *
 * 职责（对照 python 版 src/mi_auth.py + qr_mina_play.py 的 Mina 部分）：
 *   L1  米家 APP 扫码登录（account.xiaomi.com 域内执行，免密免短信）
 *   换票  passToken → sid=micoapi 的 serviceToken（免密 exchange_sid）
 *   L2  小爱云 Mina 客户端（api2.mina.mi.com，播音 / TTS / 音量 / 状态）
 *
 * 关键结论（已实测验证）：
 *   - 登录跳转链会把 serviceToken 以 Cookie 落在 .mina.mi.com、userId 落在
 *     .mi.com，passToken 是 .account.xiaomi.com 的 HttpOnly——所以「换票」
 *     这一步只需在 account 域走完整个跳转链，浏览器自动把票种好，
 *     mina 域的请求凭隐式 Cookie 即可，无需任何 token 中继/存储。
 *   - 浏览器不允许 JS 给 fetch 设 Cookie 头（forbidden header），本文件所有
 *     请求都依赖隐式 Cookie；document.cookie 只用于 deviceId/sdkVersion/userId
 *     这几个辅助票。
 *
 * 约定：本文件不得 import 任何 DOM 按钮/面板逻辑；界面在 main.js。
 * ========================================================================== */
(() => {
  "use strict";
  const Play2xiaomi = (globalThis.Play2xiaomi = globalThis.Play2xiaomi || {});

  // 调试日志：默认开启；执行 globalThis.Play2xiaomi.DEBUG = false 可整体静音。
  // 若设置了 onLog(level, text)，每条日志会额外转给页面层（main.js）显示。
  const fmt = (v) => {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  };
  const emit = (level, args) => {
    if (Play2xiaomi.DEBUG !== false) console[level]("[play2xiaomi]", ...args);
    if (typeof Play2xiaomi.onLog === "function") {
      try { Play2xiaomi.onLog(level, args.map(fmt).join(" ")); } catch (_) { /* 日志本身不许抛 */ }
    }
  };
  const log = (...a) => emit("info", a);
  const warn = (...a) => emit("warn", a);

  /* ------------------------------------------------------------------ 常量 */

  const ACCOUNT_ORIGIN = "https://account.xiaomi.com";
  const ACCOUNT_HOST = "account.xiaomi.com";
  // 落地页：任何真实响应的文档都可书签执行（403 openresty 页也无妨）
  const MINA_ORIGIN = "https://api2.mina.mi.com";
  const MINA_HOST = "api2.mina.mi.com";
  const MINA_LANDING = MINA_ORIGIN + "/";
  const LOGIN_PAGE = ACCOUNT_ORIGIN + "/pass/serviceLogin?sid=micoapi&_json=true";
  // 为什么带 &_json=true：登录落地页必须是 account.xiaomi.com 上【不会自动跳转】的页面，
  // 用户才有机会在上面点书签。直接开 /pass/serviceLogin?sid=micoapi 在"已登录"时会瞬间
  // 跳到 api2.mina.mi.com/sts（401）——用户根本没时间点书签。加 &_json=true 后服务端返回
  // JSON 文本、原地不动（未登录/已登录都稳定），main.js 注入后会清屏重绘成登录面板。

  // 这些硬件的新固件不支持 player_play_url，需 fallback 到 player_play_music
  // （对照 python 版 USE_PLAY_MUSIC_API，勿随意改动）
  const USE_PLAY_MUSIC_API = new Set([
    "LX04", "LX05", "L05B", "L05C", "L06", "L06A", "X08A", "X10A",
    "X08C", "X08E", "X8F", "X4B", "OH2", "OH2P", "X6A",
  ]);

  /* ------------------------------------------------------------ 基础小工具 */

  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  /** 与 python random.sample 对齐的不放回抽样（requestId/deviceId 用） */
  function rand(n) {
    const a = CHARS.split("");
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n).join("");
  }

  /**
   * 小米 account 域返回的 JSON 挂着 "&&&START&&&" 前缀，剥掉再 parse。
   *
   * 关键：nonce 是 19 位大整数（> Number.MAX_SAFE_INTEGER ≈ 9e15），直接 JSON.parse
   * 会丢精度（如 2818502318476480512 → …500），导致 clientSign 用错值、/sts 恒 401。
   * 先把 >=15 位的整数字面量包成字符串再解析，保住原文。
   */
  function stripXiaomi(text) {
    const s = String(text).replace("&&&START&&&", "");
    const safe = s.replace(/:(\d{15,})(?=[,}\]\s]|$)/g, ':"$1"');
    return JSON.parse(safe);
  }

  /** 只在目标域自身的页面上执行时才有意义；辅助票用（deviceId/sdkVersion/userId） */
  function setCookie(name, value, days) {
    const exp = days
      ? "; expires=" + new Date(Date.now() + days * 86400e3).toUTCString()
      : "; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    document.cookie = name + "=" + encodeURIComponent(value) + "; path=/" + exp;
  }

  function getCookie(name) {
    const m = new RegExp(
      "(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"
    ).exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : "";
  }

  /**
   * 清掉会把会话钉成"web 形"的链路 cookie。
   * 只有请求里不带 pass_ua 时，serviceLogin(micoapi) 才会返回 nonce/ssecurity（App 形），
   * 否则算不出 clientSign。必须在 account.xiaomi.com 域内执行才有效（document.cookie 只能写当前域）。
   */
  function clearWebLinkCookies() {
    if (typeof document === "undefined") return;
    for (const n of ["pass_ua", "passInfo", "cUserId", "uLocale", "theme"]) {
      for (const dom of ["", "; domain=.account.xiaomi.com", "; domain=.xiaomi.com"]) {
        document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${dom}`;
      }
    }
  }

  /** 顶层导航：跨域落 cookie 必须用它（跨域 fetch 会被 CORS 拦、cookie 也落不了） */
  function navigate(url) {
    if (typeof location !== "undefined" && typeof location.assign === "function") {
      location.assign(url);
    } else {
      warn("navigate: 非 DOM 环境，跳过顶层导航");
    }
  }

  /** SHA-1 + base64：exchange sid 的 clientSign 用（SubtleCrypto） */
  async function sha1B64(text) {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    let bin = "";
    new Uint8Array(digest).forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* -------------------------------------------------------------- HTTP 基础 */

  class ApiError extends Error {
    /** kind: 'network' | 'http' | 'api' | 'parse'，code: 小米业务码 */
    constructor(message, kind = "network", code = undefined, body = undefined) {
      super(message);
      this.name = "ApiError";
      this.kind = kind;
      this.code = code;
      this.body = body;
    }
  }

  // 便于测试替换的实现点（正式环境即 globalThis.fetch）
  Play2xiaomi._fetchImpl = (url, options) => fetch(url, options);

  async function request(url, { timeout = 25000, method = "GET", body = null, signal } = {}) {
    let text;
    let resp;
    const tag = `${method} ${url.split("?")[0]}`; // 只记路径，不带 query（可能含票据）
    log("→", tag);
    try {
      const timeoutSignal = AbortSignal.timeout(timeout);
      resp = await Play2xiaomi._fetchImpl(url, {
        method,
        body: body || undefined,
        // 带 cookie：登录跳转链会把 serviceToken 以 Set-Cookie 落到 .mina.mi.com，
        // 跨域响应不设 credentials 时浏览器不会保存这些 Cookie（同源请求无影响）。
        credentials: "include",
        // 调用方的取消 signal 与超时取并集：任一触发即中止
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      });
      text = await resp.text();
      log("←", tag, resp.status, text.length + "B");
    } catch (e) {
      if (e?.name === "AbortError") { log("✗", tag, "已取消"); throw e; } // 让上层区分"被取消"（超时则是 TimeoutError，按网络错误处理）
      warn("✗", tag, "网络失败：", e?.name || e);
      throw new ApiError(`网络请求失败 ${url} (${e?.name || e})`, "network");
    }
    if (!resp.ok) {
      throw new ApiError(
        `HTTP ${resp.status} ${url}`, "http", resp.status,
        text.length > 300 ? text.slice(0, 300) + "…" : text
      );
    }
    return text;
  }

  /** 请求并剥小米壳；不是 JSON 也能读出诊断信息 */
  async function requestJson(url, opts = {}) {
    const text = await request(url, opts);
    try {
      return stripXiaomi(text);
    } catch (_) {
      throw new ApiError("响应不是合法 JSON", "parse", undefined, text.slice(0, 300));
    }
  }

  /* ------------------------------------------------- L1 认证（account 域执行） */

  function ensureDeviceId() {
    if (!getCookie("deviceId")) setCookie("deviceId", rand(16).toUpperCase(), 3650);
  }

  /** serviceLogin通用调用（_json=true 的 GET） */
  async function serviceLogin(sid) {
    return requestJson(`${ACCOUNT_ORIGIN}/pass/serviceLogin?sid=${sid}&_json=true`);
  }

  /**
   * 生成扫码阶段参数：{ qr, loginUrl, lp }（qr 为官方二维码图片地址，可能为空）。
   *
   * 注意：不是直接请求 serviceLogin 给的 location，而是把 location 的 query 当作参数，
   * 请求固定的 longPolling/loginUrl（对照 cli/mi_auth.py 的 qr_login；直接请求 location
   * 会得到"Callback连接不合法"）。
   */
  async function buildQrStage(notLoggedInResp) {
    const params = new URL(notLoggedInResp.location, ACCOUNT_ORIGIN).searchParams;
    params.set("_qrsize", "240");
    params.set("_dc", String(Date.now()));
    const login = await requestJson(
      `${ACCOUNT_ORIGIN}/longPolling/loginUrl?${params}`, { timeout: 30000 });
    log("buildQrStage: 已取到扫码参数（qr=" + (login.qr ? "有" : "无")
      + "，loginUrl=" + (login.loginUrl ? "有" : "无") + "，lp=" + (login.lp ? "有" : "无") + "）");
    return { qr: login.qr || "", loginUrl: login.loginUrl || "", lp: login.lp };
  }

  /**
   * 米家 APP 扫码登录。
   * - 服务端曾登录过（浏览器里有有效 passToken）→ 直接返回 already，
   *   调用方走免密换票即可，不弹二维码。
   * - 否则长轮询 lp 等待扫码：服务器挂住连接返回结果；网络打嗝就重挂，
   *   最多 5 次（约 12 分钟）。onQr({qr,loginUrl}) 供界面渲染二维码。
   * 返回 { mode: 'already'|'scanned', userId }
   */
  async function qrLogin({ onQr, onPhase, signal } = {}) {
    ensureDeviceId();
    log("qrLogin: 开始（sid=mijia，检查是否已有有效凭证）");
    const r = await serviceLogin("mijia");
    if (r.code === 0) {
      log("qrLogin: 浏览器已有有效凭证，免扫码");
      return { mode: "already", userId: getCookie("userId") };
    }
    if (!r.location) {
      throw new ApiError(`serviceLogin 未给出 location：${JSON.stringify(r).slice(0, 200)}`, "api", r.code);
    }
    log("qrLogin: 未登录，拉取扫码参数");
    const stage = await buildQrStage(r);
    log("qrLogin: 扫码参数就绪（官方二维码图：" + (stage.qr ? "有" : "无") + "）");
    onQr?.(stage);
    let lp = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      onPhase?.(`等待【米家 APP】扫码…（第 ${attempt}/5 次连接）`);
      log("qrLogin: 第", attempt, "/5 次等待扫码（长轮询）");
      try {
        lp = stripXiaomi(await request(stage.lp, { timeout: 150000, signal }));
        break; // 服务器返回即代表本轮长轮询结束
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        if (e?.kind === "http" || e?.kind === "parse") throw e; // 接口层面问题，重挂无意义
        warn("qrLogin: 第", attempt, "次等待中断（", e?.kind || e?.name, "），准备重挂");
        if (attempt === 5) throw new ApiError("等待扫码超时（连接多次中断），请重新发起登录", "network");
      }
    }
    if (!lp) throw new ApiError("等待扫码被取消", "network");
    if (lp.code !== 0) {
      throw new ApiError(`扫码登录失败 code=${lp.code} ${lp.description || ""}`, "api", lp.code);
    }
    // —— lp 的字段就是登录本体（对照 cli/mi_auth.py 的 qr_login）——
    // px: lp 里直接带走 userId/passToken/ssecurity；把 account 域需要的辅助票自己补上，
    // 不要重依赖后面那一次跨域回调（sts.api.mijia.tech，浏览器 fetch 读不到，会 ERR_FAILED）。
    log("qrLogin: 扫码结果字段 =", Object.keys(lp).filter(k => /token|userId|ssecurity|nonce|Device|device/i.test(k)).join(","));
    if (lp.userId) setCookie("userId", String(lp.userId), 3650);          // 换票链要用的辅助票
    if (lp.passToken) warn("passToken 由服务器以 HttpOnly 下发，浏览器侧只能依赖回调链种植（无法 document.cookie 直写）");
    // 回调（sts.api.mijia.tech/mijia/sts）浏览器里 fetch 会被 CORS 拦（net::ERR_FAILED）；
    // 它只负责给 .mijia.tech / .mi.com 落 Cookie，对换成 micoapi 不是必须的。
    // 用 <img> 触发一次硬翻——服务器照常处理跳转链并落 Cookie，而 image 不受 CORS 限制。
    if (typeof Image === "function") {
      await new Promise((res) => {
        const img = new Image();
        img.onload = img.onerror = () => res();
        img.src = lp.location;
        setTimeout(res, 15000); // 极端网络下别挂死
      });
      log("qrLogin: 扫码成功，回调已（尽力）触发");
    } else {
      warn("qrLogin: 非 DOM 环境（如 smoke 测试），跳过 <img> 回调触发");
    }
    return { mode: "scanned", userId: String(lp.userId), ssecurity: lp.ssecurity ?? "" };
  }

  /**
   * 免密换票：把 account 域的有效凭证换成 sid=micoapi 的 serviceToken。
   *
   * 实测关键点（务必保留）：
   *  1) 请求带 pass_ua=web 时 serviceLogin 不返回 nonce/ssecurity（无 App 形）→ 先清 web 链路 cookie；
   *  2) nonce 是 >2^53 的大整数（stripXiaomi 已保成字符串），否则 clientSign 必错；
   *  3) 最后 /sts 在 api2.mina.mi.com，跨域 fetch 会被 CORS 拦（读不到、也不落 cookie），
   *     必须用顶层导航让浏览器原生跟随 —— 所以本函数不返回，页面会跳到 /sts。
   * 命中后 serviceToken 落在 .mina.mi.com，控制台切回本页即可用（main.js 的 focus 兜底会 probe）。
   */
  async function exchangeMicoapi() {
    ensureDeviceId();
    setCookie("sdkVersion", "3.9", 365);
    clearWebLinkCookies();
    log("exchangeMicoapi: 开始换取 sid=micoapi 票");
    const r = await serviceLogin("micoapi");
    if (r.code !== 0 || !r.location) {
      throw new ApiError(`micoapi 换票失败 code=${r.code} ${r.description || ""}`, "api", r.code);
    }
    if (!r.nonce || !r.ssecurity) {
      throw new ApiError("micoapi 未返回 nonce/ssecurity（仍处 web 会话？pass_ua 没清掉）", "api", r.code);
    }
    const nsec = `nonce=${r.nonce}&${r.ssecurity}`;
    const sign = await sha1B64(nsec);
    const url = r.location + "&clientSign=" + encodeURIComponent(sign);
    log("exchangeMicoapi: 顶层导航到 /sts 落 serviceToken（跨域 fetch 会被 CORS 拦）");
    navigate(url);
    return { ok: true, navigated: true, url };
  }

  /**
   * 一步到位：扫码（或免扫码复用已有票）→ 换 micoapi 票。
   * 完成（无论哪种 mode）后 .mina.mi.com 的票就绪。
   */
  async function loginMina({ onQr, onPhase, signal } = {}) {
    log("loginMina: 开始");
    const result = await qrLogin({ onQr, onPhase, signal });
    if (result.userId) setCookie("userId", result.userId, 3650); // 换票链所需的辅助票
    await exchangeMicoapi();
    log("loginMina: 完成 mode=", result.mode);
    return result;
  }

  /* ---------------------------------------- L2 小爱云 Mina（mina 域执行） */

  class Mina {
    constructor() { this._hwMap = null; }

    async _get(uri, params = {}) {
      const qs = new URLSearchParams({ ...params, requestId: "app_ios_" + rand(30) });
      return requestJson(MINA_ORIGIN + uri + "?" + qs);
    }

    async _post(uri, params = {}) {
      const form = new URLSearchParams({ ...params, requestId: "app_ios_" + rand(30) });
      return requestJson(MINA_ORIGIN + uri, { method: "POST", body: form });
    }

    /** 设备表（data 直为数组）。未登录时抛 ApiError(kind='api', code=小米码) */
    async deviceList(master = 0) {
      const r = await this._get("/admin/v2/device_list", { master });
      if (r.code !== 0) {
        warn("deviceList: 失败 code=", r.code, r.description || r.message || "");
        throw new ApiError(`device_list code=${r.code} ${r.description || r.message || ""}`, "api", r.code);
      }
      log("deviceList: OK，设备数 =", (r.data || []).length);
      return r.data || [];
    }

    /** ubus 远程调用：所有音箱控制的底座 */
    async ubus(did, method, path, msg) {
      log("ubus:", method, "path=" + path, "device=" + did);
      return this._post("/remote/ubus", {
        deviceId: did, method, path, message: JSON.stringify(msg),
      });
    }

    tts(did, text) {
      return this.ubus(did, "text_to_speech", "mibrain", { text });
    }

    stop(did) {
      return this.ubus(did, "player_play_operation", "mediaplayer",
        { action: "stop", media: "app_ios" });
    }

    setVolume(did, volume) {
      return this.ubus(did, "player_set_volume", "mediaplayer",
        { volume, media: "app_ios" });
    }

    getStatus(did) {
      return this.ubus(did, "player_get_play_status", "mediaplayer",
        { media: "app_ios" });
    }

    /** 设备型号表：一次 device_list 缓存整张 deviceID → hardware，供播放 API 选路 */
    async _hardware(did) {
      if (!this._hwMap) {
        log("_hardware: 首次播放，拉取设备表建立型号缓存");
        this._hwMap = {};
        for (const d of await this.deviceList()) {
          if (d.deviceID) this._hwMap[d.deviceID] = d.hardware || "";
        }
      }
      return this._hwMap[did] || "";
    }

    async playUrl(did, url, type = 2) {
      const hw = await this._hardware(did);
      if (USE_PLAY_MUSIC_API.has(hw)) {
        log("playUrl: 型号", hw || "?", "命中 USE_PLAY_MUSIC_API → player_play_music");
        return this.playMusicUrl(did, url, type);
      }
      const r = await this.ubus(did, "player_play_url", "mediaplayer",
        { url, type, media: "app_ios" });
      const dcode = r?.data?.code;
      if (dcode !== undefined && dcode !== null && dcode !== 0) {
        // 仅对"型号不支持 play_url"这类可用性错误有意义；鉴权/参数类错误也会走到这里，
        // 与 python 版行为保持一致，不额外区分。
        log("playUrl: player_play_url data.code =", dcode, "→ fallback player_play_music");
        return this.playMusicUrl(did, url, type); // fallback（对照 python 版）
      }
      log("playUrl: player_play_url 下发成功");
      return r;
    }

    async playMusicUrl(did, url, type = 2) {
      const music = {
        payload: {
          audio_type: type === 1 ? "MUSIC" : "",
          audio_items: [{
            item_id: {
              audio_id: "1582971365183456177",
              cp: { album_id: "-1", episode_index: 0, id: "355454500", name: "xiaowei" },
            },
            stream: { url },
          }],
          list_params: {
            listId: "-1", loadmore_offset: 0,
            origin: "xiaowei", type: "MUSIC",
          },
        },
        play_behavior: "REPLACE_ALL",
      };
      return this.ubus(did, "player_play_music", "mediaplayer", {
        startaudioid: "1582971365183456177",
        music: JSON.stringify(music),
      });
    }

    /** 运行时探测 type=暂停/继续；返回 {supported, resp}，结果缓存 */
    async playOperation(did, action) {
      const resp = await this.ubus(did, "player_play_operation", "mediaplayer",
        { action, media: "app_ios" });
      const ok = resp?.code === 0 &&
        ((resp?.data?.code === undefined) || resp.data.code === null || resp.data.code === 0);
      return { supported: ok, resp };
    }
  }

  /* ------------------------------------------------------------- 对外导出 */

  Object.assign(Play2xiaomi, {
    // 协议常量
    ACCOUNT_ORIGIN, ACCOUNT_HOST, MINA_ORIGIN, MINA_HOST, MINA_LANDING,
    LOGIN_PAGE, USE_PLAY_MUSIC_API,
    // 客户端与流程
    Mina, loginMina, qrLogin, exchangeMicoapi, ensureDeviceId,
    // 工具
    ApiError, rand, getCookie, setCookie, stripXiaomi, sleep,
    // 调试
    log, warn,
  });
})();
