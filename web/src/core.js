/* ============================================================================
 * play2xiaomi · core.js —— 协议层（无 DOM 依赖，可独立测试）
 *
 * 职责（对照 python 版 src/mi_auth.py + qr_mina_play.py 的 Mina 部分）：
 *   L1  米家 APP 扫码登录（account.xiaomi.com 域内执行，免密免短信）
 *   换票  passToken → sid=micoapi 的 serviceToken（免密 exchange_sid）
 *   L2  小爱云 Mina 客户端（api2.mina.mi.com，播音 / TTS / 音量 / 状态）
 *   QR  纯 JS 二维码生成（零依赖，实现参考 Project Nayuki，MIT）
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
  const P2X = (globalThis.P2X = globalThis.P2X || {});

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
  P2X._fetchImpl = (url, options) => fetch(url, options);

  async function request(url, { timeout = 25000, method = "GET", body = null, signal } = {}) {
    let resp;
    try {
      resp = await P2X._fetchImpl(url, {
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

  /* ------------------------------------------------- QR 生成（零依赖纯 JS）
   * 实现参考 Project Nayuki《QR-Code-generator》(MIT License, 公开算法与
   * 常量表)，https://www.nayuki.io/page/qr-code-generator-library
   * 本实现仅为免依赖的精简版：字节段、全部版本 1-40、纠错等级 M。
   * 说明：主路径展示官方 login.qr 图片，此生成器是缺图时的兜底。
   */

  // //0,1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19 … 40
  const QR_ECC_M = [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28,
    28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28,
  ];
  const QR_BLOCKS_M = [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ];

  function qrRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function qrDataCodewords(ver) {
    return Math.floor(qrRawDataModules(ver) / 8) - QR_ECC_M[ver] * QR_BLOCKS_M[ver];
  }

  // GF(2^8 / 0x11D) 俄罗斯农民乘法
  function rsMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = rsMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = rsMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => (result[i] ^= rsMul(coef, factor)));
    }
    return result;
  }

  /** 生成 QR 模块矩阵 {size, modules: boolean[][]} */
  function qrGenerate(text) {
    const bytes = new TextEncoder().encode(text);

    let version = 1;
    while (version <= 40) {
      const ccBits = version < 10 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= qrDataCodewords(version) * 8) break;
      version++;
    }
    if (version > 40) throw new Error("QR 数据过长（>2953 字节）");

    // ---- 位流：模式0100 + 长度 + 数据 + 终止 + 字节对齐 + EC 轮替填充 ----
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(0x4, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const cap = qrDataCodewords(version) * 8;
    push(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
    const dataCw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      dataCw.push(byte);
    }

    // ---- 网格与功能图形 ----
    const size = version * 4 + 17;
    const blank = () => Array.from({ length: size }, () => new Array(size).fill(false));
    const modules = blank();
    const isFunc = blank();
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFunc[y][x] = true; };

    for (let i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            setFn(x, y, d !== 2 && d !== 4);
          }
        }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    if (version !== 1) {
      const numAlign = Math.floor(version / 7) + 2;
      const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
      const pos = [6];
      for (let p = size - 7; pos.length < numAlign; p -= step) pos.splice(1, 0, p);
      for (let i = 0; i < pos.length; i++)
        for (let j = 0; j < pos.length; j++)
          if (!(i === 0 && j === 0 || i === 0 && j === pos.length - 1 || i === pos.length - 1 && j === 0)) {
            const aa = pos[i], bb2 = pos[j];
            for (let dy = -2; dy <= 2; dy++)
              for (let dx = -2; dx <= 2; dx++)
                setFn(aa + dx, bb2 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
    }

    const drawFormat = (mask) => {
      const data = (0 << 3) | mask; // MEDIUM 的 formatBits = 0
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = (data << 10 | rem) ^ 0x5412;
      const bit = (i) => ((b >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
      setFn(8, size - 8, true);
    };
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = version << 12 | rem;
      const bit = (i) => ((b >>> i) & 1) !== 0;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + i % 3, c = Math.floor(i / 3);
        setFn(a, c, bit(i));
        setFn(c, a, bit(i));
      }
    }
    drawFormat(0); // 先画占位，掩码选定后重画

    // ---- ECC 插入与交织 ----
    const numBlocks = QR_BLOCKS_M[version];
    const blockEcc = QR_ECC_M[version];
    const rawCw = Math.floor(qrRawDataModules(version) / 8);
    const numShort = numBlocks - rawCw % numBlocks;
    const shortLen = Math.floor(rawCw / numBlocks);
    const div = rsDivisor(blockEcc);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = dataCw.slice(k, k + shortLen - blockEcc + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const allCw = [];
    for (let i = 0; i < blocks[0].length; i++)
      blocks.forEach((blk, j) => {
        if (i !== shortLen - blockEcc || j >= numShort) allCw.push(blk[i]);
      });

    // ---- 之字扫描放码 ----
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunc[y][x] && bi < allCw.length * 8) {
            modules[y][x] = ((allCw[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
            bi++;
          }
        }
      }
    }

    // ---- 掩码 ----
    const applyMask = (m) => {
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          let invert;
          switch (m) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
            case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
            default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
          }
          if (!isFunc[y][x] && invert) modules[y][x] = !modules[y][x];
        }
    };
    const penaltyScore = () => {
      let result = 0;
      const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
      const linePenalty = (get) => {
        let runColor = false, runLen = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        let score = 0;
        const addHistory = (len) => {
          if (history[0] === 0) len += size;
          history.pop(); history.unshift(len);
        };
        const countPatterns = () => {
          const n = history[1];
          const core = n > 0 && history[2] === n && history[3] === n * 3 &&
            history[4] === n && history[5] === n;
          return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
                 (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
        };
        const terminate = (color, len) => {
          if (color) { addHistory(len); len = 0; }
          len += size;
          addHistory(len);
          return countPatterns();
        };
        for (let k = 0; k < size; k++) {
          const color = get(k);
          if (color === runColor) {
            runLen++;
            if (runLen === 5) score += N1;
            else if (runLen > 5) score += 1;
          } else {
            addHistory(runLen);
            if (!runColor) score += countPatterns() * N3;
            runColor = color;
            runLen = 1;
          }
        }
        score += terminate(runColor, runLen) * N3;
        return score;
      };
      for (let y = 0; y < size; y++)
        result += linePenalty((x) => modules[y][x]);
      for (let x = 0; x < size; x++)
        result += linePenalty((y) => modules[y][x]);
      for (let y = 0; y < size - 1; y++)
        for (let x = 0; x < size - 1; x++) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1])
            result += N2;
        }
      let dark = 0;
      for (const row of modules) dark += row.reduce((s, c) => s + (c ? 1 : 0), 0);
      const total = size * size;
      const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      result += k * N4;
      return result;
    };
    let mask = 0, minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const p = penaltyScore();
      if (p < minPenalty) { mask = m; minPenalty = p; }
      applyMask(m); // XOR 自逆
    }
    applyMask(mask);
    drawFormat(mask);
    return { size, modules, version, mask };
  }

  /* ------------------------------------------------------------- 对外导出 */

  Object.assign(P2X, {
    // 协议常量
    ACCOUNT_ORIGIN, ACCOUNT_HOST, MINA_ORIGIN, MINA_HOST, MINA_LANDING,
    LOGIN_PAGE, USE_PLAY_MUSIC_API,
    // 客户端与流程
    Mina, loginMina, qrLogin, exchangeMicoapi, ensureDeviceId,
    // 工具
    ApiError, rand, getCookie, setCookie, stripXiaomi, sleep, qrGenerate,
  });
})();
