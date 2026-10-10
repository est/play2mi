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

  /* ------------------------------------------------------------------ 常量 */

  const ACCOUNT_ORIGIN = "https://account.xiaomi.com";
  const ACCOUNT_HOST = "account.xiaomi.com";
  // 落地页：任何真实响应的文档都可书签执行（403 openresty 页也无妨）
  const MINA_ORIGIN = "https://api2.mina.mi.com";
  const MINA_HOST = "api2.mina.mi.com";
  const MINA_LANDING = MINA_ORIGIN + "/";
  const LOGIN_PAGE = ACCOUNT_ORIGIN + "/fe/service/login?sid=mijia";

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

  /** 小米 account 域返回的 JSON 挂着 "&&&START&&&" 前缀，剥掉再 parse */
  function stripXiaomi(text) {
    return JSON.parse(String(text).replace("&&&START&&&", ""));
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
    let resp;
    try {
      resp = await Play2xiaomi._fetchImpl(url, {
        method,
        body: body || undefined,
        signal: signal || AbortSignal.timeout(timeout),
        headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      });
      var text = await resp.text();          // eslint-disable-line no-var
    } catch (e) {
      if (e?.name === "AbortError") throw e; // 让上层区分"被取消"
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

  /** 生成扫码阶段参数：{ qr, loginUrl, lp }（qr 为官方二维码图片地址，可能为空） */
  async function buildQrStage(notLoggedInResp) {
    const loc = new URL(notLoggedInResp.location);
    loc.searchParams.set("_qrsize", "240");
    loc.searchParams.set("_dc", String(Date.now()));
    const login = await requestJson(loc.href, { timeout: 30000 });
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
    const r = await serviceLogin("mijia");
    if (r.code === 0) return { mode: "already", userId: getCookie("userId") };
    if (!r.location) {
      throw new ApiError(`serviceLogin 未给出 location：${JSON.stringify(r).slice(0, 200)}`, "api", r.code);
    }
    const stage = await buildQrStage(r);
    onQr?.(stage);
    let lp = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      onPhase?.(`等待【米家 APP】扫码…（第 ${attempt}/5 次连接）`);
      try {
        lp = stripXiaomi(await request(stage.lp, { timeout: 150000, signal }));
        break; // 服务器返回即代表本轮长轮询结束
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        if (e?.kind === "http" || e?.kind === "parse") throw e; // 接口层面问题，重挂无意义
        if (attempt === 5) throw new ApiError("等待扫码超时（连接多次中断），请重新发起登录", "network");
      }
    }
    if (!lp) throw new ApiError("等待扫码被取消", "network");
    if (lp.code !== 0) {
      throw new ApiError(`扫码登录失败 code=${lp.code} ${lp.description || ""}`, "api", lp.code);
    }
    await request(lp.location, { timeout: 30000 }); // 回调落 cookie（passToken 等，HttpOnly）
    return { mode: "scanned", userId: String(lp.userId) };
  }

  /**
   * 免密换票：把浏览器里已有的有效凭证换成 sid=micoapi 的 serviceToken。
   * 票本身由跳转链写进 .mina.mi.com Cookie（浏览器自动携带），这里不取值。
   */
  async function exchangeMicoapi() {
    ensureDeviceId();
    setCookie("sdkVersion", "3.9", 365);
    const r = await serviceLogin("micoapi");
    if (r.code !== 0 || !r.location) {
      throw new ApiError(`micoapi 换票失败 code=${r.code} ${r.description || ""}`, "api", r.code);
    }
    const nsec = `nonce=${r.nonce}&${r.ssecurity}`;
    const sign = await sha1B64(nsec);
    await request(r.location + "&clientSign=" + encodeURIComponent(sign), { timeout: 30000 });
    return { ok: true };
  }

  /**
   * 一步到位：扫码（或免扫码复用已有票）→ 换 micoapi 票。
   * 完成（无论哪种 mode）后 .mina.mi.com 的票就绪。
   */
  async function loginMina({ onQr, onPhase, signal } = {}) {
    const result = await qrLogin({ onQr, onPhase, signal });
    if (result.userId) setCookie("userId", result.userId, 3650); // 换票链所需的辅助票
    await exchangeMicoapi();
    return result;
  }

  /* ---------------------------------------- L2 小爱云 Mina（mina 域执行） */

  class Mina {
    constructor() { this._hw = {}; }

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
        throw new ApiError(`device_list code=${r.code} ${r.description || r.message || ""}`, "api", r.code);
      }
      return r.data || [];
    }

    /** ubus 远程调用：所有音箱控制的底座 */
    async ubus(did, method, path, msg) {
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

    async _hardware(did) {
      if (did !== this._hw.did) {
        this._hw = { did, map: {} };
        for (const d of await this.deviceList()) {
          if (d.deviceID) this._hw.map[d.deviceID] = d.hardware || "";
        }
      }
      return this._hw.map[did] || "";
    }

    async playUrl(did, url, type = 2) {
      if (USE_PLAY_MUSIC_API.has(await this._hardware(did))) {
        return this.playMusicUrl(did, url, type);
      }
      const r = await this.ubus(did, "player_play_url", "mediaplayer",
        { url, type, media: "app_ios" });
      const dcode = r?.data?.code;
      if (dcode !== undefined && dcode !== null && dcode !== 0) {
        return this.playMusicUrl(did, url, type); // fallback（对照 python 版）
      }
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
  });
})();
