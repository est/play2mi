/* ============================================================================
 * play2xiaomi · core.js —— 协议层（无 DOM 依赖，可独立测试）
 *
 * 职责（对照 python 版 qr_mina_play.py 的 Mina 部分）：
 *   L1  登录：直接交给小米官方登录页 LOGIN_PAGE（sid=micoapi）。该页面的回调就是
 *       https://api2.mina.mi.com/sts，浏览器会据此把 serviceToken 写到 .mina.mi.com；
 *       本文件不再自己取二维码 / 换票。
 *   L2  小爱云 Mina 客户端（api2.mina.mi.com，播音 / TTS / 音量 / 状态）
 *
 * 关键结论：
 *   - account.xiaomi.com 不返回 Access-Control-Allow-Origin，所以在 api2.mina.mi.com
 *     页面上跨域读不到它的响应——自定义扫码/换票在书签里做不到，只能借官方登录页完成。
 *   - 浏览器不允许 JS 给 fetch 设 Cookie 头（forbidden header），Mina 请求全靠隐式 Cookie。
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
  const LOGIN_PAGE = ACCOUNT_ORIGIN + "/pass/serviceLogin?sid=micoapi";

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

  /* ------------------------------------------------- L1 认证（account 域） */
  // 登录不由本文件实现：直接用小米官方登录页（LOGIN_PAGE），它的回调就是
  // https://api2.mina.mi.com/sts，官方页面会让浏览器把 serviceToken 写到 .mina.mi.com。
  // 之所以不自己取码/换票：浏览器 CORS 不允许我们从 api2.mina.mi.com 读 account.xiaomi.com
  // 的响应（该域不返回 Access-Control-Allow-Origin），自定义流程在书签里根本走不通。

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
    // 客户端
    Mina,
    // 工具
    ApiError, rand, stripXiaomi, sleep,
    // 调试
    log, warn,
  });
})();
