/* ============================================================================
 * play2xiaomi · main.js —— 入口与界面层
 *
 * 职责：
 *   1. 按 location 分派三种执行环境：
 *      a. api2.mina.mi.com       → 控制台面板（日常使用的主界面）
 *      b. account.xiaomi.com     → 登录页（扫码/换票，完成后 postMessage 回控制台）
 *      c. 其他任意页面          → window.open 打开控制台页，轻提示"再点一次书签"
 *   2. 覆盖式 UI：注入 overlay 面板，不依赖页面任何内容；可关闭，关闭不打断
 *      音箱播放（面板从不主动 stop，仅 TTS 前按协议 stop→等 2s→播报）。
 *
 * 重复点击书签：import() 带 cache-busting 会重新执行本文件，
 * 用 #p2x-root 是否存在判定"已注入"，转而做面板开合切换。
 * ========================================================================== */
(() => {
  "use strict";
  const C = globalThis.Play2xiaomi;
  if (!C) throw new Error("Play2xiaomi 未初始化（core.js 未先行加载）");

  // 与 core.js 同一套日志开关（globalThis.Play2xiaomi.DEBUG = false 可整体静音）
  const log = C.log;
  const warn = C.warn;
  // 兜住未捕获错误/未处理 Promise，避免"点了没反应"时静默
  if (!window.__p2xErrHooked) {
    window.__p2xErrHooked = true;
    window.addEventListener("error", (e) =>
      warn("window.onerror:", e.message, (e.filename || "") + ":" + (e.lineno || 0)));
    window.addEventListener("unhandledrejection", (e) => warn("unhandledrejection:", e.reason));
  }

  const KEY_DEVICE = "p2x:lastDevice";
  // player_get_play_status 的 status 数值 → 文案（未知值则原样显示）
  const STATUS_TEXT = { 1: "▶ 播放中", 0: "■ 已停止", [-1]: "- 空闲" };

  const state = {
    mina: new C.Mina(),
    devices: [],
    selected: "",
    panel: null,        // 控制台面板根节点（仅 mina 页有）
    views: {},
    abortLogin: null,   // 登录页长轮询的取消信号
    loginWin: null,     // 打开登录页的窗口句柄（登录成功后自动关闭它）
    pauseSupported: undefined, // 运行时探测结果缓存
  };

  /* --------------------------------------------------------------- DOM 基础 */

  let busy = false; // 防止播放/播报按钮连点

  // attrs 允许传 null（如 el("div", null, child)）：默认值只兜 undefined，不兜 null，这里统一归一化
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null) continue;
      if (k === "text") node.textContent = v;
      else if (k === "className" || k === "class") node.className = v;
      else if (k === "data") for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "on") for (const [n, f] of Object.entries(v)) node.addEventListener(n, f);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null) continue;
      node.append(c);
    }
    return node;
  };
  /** 自定义选择器简写：p2x 井区查找 */
  const $ = (sel, root) => (root || state.panel).querySelector(sel);

  // —— 页面日志：core.js/main.js 的每条 log 都镜像到此，既便于排查也填充页面 ——
  const pageLogs = [];
  let logBox = null;
  const lineEl = (level, text) =>
    el("div", { className: "ln" + (level === "warn" ? " w" : ""), text });
  function flushLogs() {
    if (!logBox) return;
    logBox.replaceChildren();
    for (const { level, text } of pageLogs) logBox.append(lineEl(level, text));
    logBox.scrollTop = logBox.scrollHeight;
  }
  function pushLog(level, text) {
    const stamped = new Date().toLocaleTimeString() + "  " + text;
    pageLogs.push({ level, text: stamped });
    if (pageLogs.length > 800) pageLogs.shift();
    if (logBox) {
      logBox.append(lineEl(level, stamped));
      logBox.scrollTop = logBox.scrollHeight;
    }
  }
  C.onLog = pushLog; // core.js 的 log/warn 一并转到这里

  const css = `
body.p2x-page{margin:0;background:#fff;color:#1f2329;
  font:14px/1.65 -apple-system,"PingFang SC","Segoe UI",sans-serif;}
#p2x-root{max-width:680px;margin:0 auto;padding:34px 20px 70px;}
.p2x-head{display:flex;align-items:center;gap:8px;font-size:20px;font-weight:700;margin:0 0 18px;}
.p2x-head .sp{flex:1}
.p2x-btn{cursor:pointer;padding:7px 13px;border-radius:9px;border:1px solid #e1e5ea;background:#f5f6f8;
  color:inherit;font:inherit;white-space:nowrap;text-decoration:none;display:inline-block}
.p2x-btn:hover{background:#eceef2}
.p2x-btn.primary{background:#ff6900;border-color:#ff6900;color:#fff}
.p2x-btn.primary:hover{background:#f35f00}
.p2x-btn:disabled{opacity:.45;cursor:not-allowed}
.p2x-body{display:flex;flex-direction:column;gap:12px}
.p2x-row{display:flex;gap:8px;align-items:center}
.p2x-row label{flex:none;color:#6b7280}
.p2x-select,.p2x-input{flex:1;min-width:0;background:#fff;border:1px solid #d8dde3;
  color:inherit;border-radius:9px;padding:8px 10px;font:inherit;width:100%}
.p2x-status{color:#6b7280;min-height:18px;font-size:13px;word-break:break-all}
.p2x-status.err{color:#d23b3b}
.p2x-view{display:none}.p2x-view.on{display:block}
.p2x-note{color:#8b93a1;font-size:12px}
.p2x-qr{background:#f8f9fb;border:1px solid #eceef2;border-radius:12px;padding:12px;
  display:flex;flex-direction:column;align-items:center;gap:8px}
.p2x-qr img{width:240px;height:240px}
.p2x-foot{margin-top:22px;padding-top:12px;border-top:1px solid #eceff3;
  color:#98a2b3;font-size:11.5px;display:flex;gap:10px;align-items:center}
.p2x-link{color:#2563eb;cursor:pointer;text-decoration:underline}
.p2x-detail{margin:0;font-size:12px;color:#6b7280;word-break:break-all;white-space:pre-wrap}
.p2x-detail summary{cursor:pointer}
.p2x-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483002;
  background:#1f2329;color:#fff;padding:10px 18px;border-radius:10px;
  font:13px -apple-system,"PingFang SC",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25);max-width:70vw}
.p2x-logtitle{margin:26px 0 8px;font-size:12px;color:#98a2b3;letter-spacing:.03em}
.p2x-log{background:#0f1115;color:#d7dbe0;border-radius:10px;padding:12px 14px;min-height:120px;
  max-height:300px;overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.p2x-log .ln{white-space:pre-wrap;word-break:break-all}
.p2x-log .w{color:#ffb86c}
`;

  /** 清空原页面（mina 域下就是个 403/404 空壳），铺上我们自己的白底 */
  function resetPage() {
    document.title = "播放到小爱";
    document.head.innerHTML =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
    document.body.replaceChildren();
    document.body.className = "p2x-page";
  }

  function injectShell() {
    resetPage();
    document.head.append(el("style", { id: "p2x-style", text: css }));
    const root = el("div", { id: "p2x-root" });
    document.body.append(root);
    log("injectShell: 已清空原页面并重绘为整页控制台");
    return root;
  }

  function toast(text, ms = 5200) {
    const t = el("div", { className: "p2x-toast", text });
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }

  /* ------------------------------------------------------------- 控制台面板 */

  function buildPanel(root) {
    log("buildPanel: 构建面板");
    state.panel = root;
    root.append(
      el("div", { className: "p2x-head" }, "🔊 播放到小爱"),
      el("div", { className: "p2x-body", data: { body: "" } },
        // —— 视图：加载中 ——
        view("loading", el("div", { className: "p2x-status", data: { load: "" } }, "连接中…")),
        // —— 视图：需要登录 ——
        view("login",
          el("div", null,
            el("div", { text: "还没有登录小爱云（或凭证过期）。" }),
            el("div", { style: "height:10px" }),
            // 用 window.open 而非 target=_blank：保留窗口句柄，登录成功后自动关掉它。
            // 落地页带 &_json=true（见 core.js LOGIN_PAGE），不会自动跳走，用户能从容点书签。
            el("a", { className: "p2x-btn primary", href: C.LOGIN_PAGE, target: "_blank",
              on: { click: (e) => {
                e.preventDefault();
                state.loginWin = window.open(C.LOGIN_PAGE, "p2x_login");
                log("登录视图: 已打开登录页窗口 =", !!state.loginWin);
              } } }, "🔐 去扫码登录"),
            el("div", { style: "height:10px" }),
            el("div", { className: "p2x-note",
              text: "新标签页会打开一个小米账号页面（可能只显示一串 JSON，属正常）；请在那个页面里再点一次书签，即可显示二维码（免密码、免短信）。扫完切回本页会自动刷新，登录标签页也会自动关闭。" }))),
        // —— 视图：主面板 ——
        view("main",
          el("div", { className: "p2x-row" },
            el("label", { text: "设备" }),
            el("select", { className: "p2x-select", data: { device: "" },
              on: { change: (e) => { state.selected = e.target.value; state.pauseSupported = undefined; localStorage.setItem(KEY_DEVICE, state.selected); refreshStatus(); } } }),
            el("button", { className: "p2x-btn", title: "刷新设备列表", data: { act: "devs" } }, "⟳")),
          el("div", { className: "p2x-row" },
            el("input", { className: "p2x-input", data: { url: "" },
              placeholder: "http(s):// 音频地址", spellcheck: "false",
              on: { keydown: (e) => e.key === "Enter" && act("play") } }),
            el("button", { className: "p2x-btn primary", data: { act: "play" } }, "▶ 播放")),
          el("div", { className: "p2x-row" },
            el("input", { className: "p2x-input", data: { tts: "" }, placeholder: "要播报的文字（TTS）",
              on: { keydown: (e) => e.key === "Enter" && act("tts") } }),
            el("button", { className: "p2x-btn", data: { act: "tts" } }, "📢 播报"),
            el("button", { className: "p2x-btn", data: { act: "tts2" },
              title: "备用 TTS：mibrain.ai_tts_request（某些机型 text_to_speech 无声时试）" }, "🔊 播报②")),
          el("div", { className: "p2x-row" },
            el("label", { text: "音量" }),
            el("input", { data: { vol: "" }, type: "range", min: "0", max: "100",
              on: { input: (e) => { $(q.volv).textContent = e.target.value; } } }),
            el("span", { data: { volv: "" }, style: "width:36px;text-align:right" }),
            el("button", { className: "p2x-btn", data: { act: "vol" } }, "设定")),
          el("div", { className: "p2x-row" },
            el("button", { className: "p2x-btn", data: { act: "pause" } }, "⏸ 暂停/继续"),
            el("button", { className: "p2x-btn", data: { act: "stop" } }, "■ 停止"),
            el("button", { className: "p2x-btn", data: { act: "status" } }, "↻ 状态")),
          el("details", { className: "p2x-detail", data: { raw: "" }, hidden: "" },
            el("summary", { text: "最近一次响应" }),
            el("div", { data: { rawBody: "" } })),
          el("div", { className: "p2x-status", data: { msg: "" } }))),
      el("div", { className: "p2x-logtitle", text: "运行日志" }),
      el("div", { className: "p2x-log", data: { log: "" } }),
      el("div", { className: "p2x-foot" },
        el("a", { className: "p2x-link", href: C.LOGIN_PAGE, target: "_blank", rel: "noopener", text: "重新登录" }),
        el("span", { style: "flex:1" }),
        el("span", { text: "无服务器 · 浏览器直连" })),
    );

    // dataset 已由浏览器直接处理（attrs 的 data:{...} → dataset）

    root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn) onButton(btn.dataset.act);
    });

    state.views = {};
    for (const v of root.querySelectorAll(".p2x-view")) state.views[v.dataset.viewName] = v;
    logBox = $(q.log);
    flushLogs();
    log("buildPanel: 完成，视图 =", Object.keys(state.views).join("/"));
  }

  const q = {
    view: (n) => `.p2x-view[data-view-name="${n}"]`,
    load: '[data-load=""]', msg: '[data-msg=""]',
    device: "select[data-device]", url: '[data-url=""]', tts: '[data-tts=""]',
    vol: '[data-vol=""]', volv: '[data-volv=""]', raw: '[data-raw=""]',
    // 注意 dataset 会把 camelCase 键转成 kebab-case 属性：data.rawBody → data-raw-body
    rawBody: '[data-raw-body=""]', log: '[data-log=""]',
  };

  /** 创建一个可切换的视图容器 */
  function view(name, ...nodes) {
    const d = el("div", { className: "p2x-view" });
    d.dataset.viewName = name;
    d.append(...nodes);
    return d;
  }

  function setView(name) {
    for (const [k, v] of Object.entries(state.views)) v.classList.toggle("on", k === name);
  }

  function setMsg(text, isErr) {
    const node = $(q.msg);
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("err", !!isErr);
  }

  /**
   * 把响应里形如 JSON 字符串的字段解出来，便于 pretty print。
   * 小米 mediaplayer 的播放详情塞在 data.info（一个 JSON 字符串）里，直接打印是一坨
   * 转义字符串；这里解成对象后按 2 空格缩进展示。info 不是 JSON 就原样返回。
   */
  function decodeInfo(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const data = obj.data;
    if (!data || typeof data !== "object" || typeof data.info !== "string") return obj;
    try { return { ...obj, data: { ...data, info: JSON.parse(data.info) } }; }
    catch (_) { return obj; }
  }

  function showRaw(obj) {
    const det = $(q.raw);
    const body = $(q.rawBody);
    if (det) det.hidden = !obj;
    if (body) body.textContent = obj ? JSON.stringify(decodeInfo(obj), null, 2) : "";
  }

  function loadData(name) { return $(`[data-${name}=""]`)?.value; }

  /* ------------------------------------------------------------- 入口分派 */

  function init() {
    log("init: 触发（href=" + location.href + "，readyState=" + document.readyState + "）");
    try {
      // 每次书签都带 ?t= 强制重新执行：直接清空原页面整页重绘，不做小窗叠加
      // 开发预览钩子：dev/preview.html 里可强制走某分支（window.__P2X_FORCE__='mina'|'account'）
      const forced = window.__P2X_FORCE__;
      if ((forced === "mina" && location.host !== C.MINA_HOST) ||
          (forced === "account" && location.origin !== C.ACCOUNT_ORIGIN)) {
        log("init: dev preview 强制分支 =", forced);
        const root = injectShell();
        forced === "mina" ? setupMina(root) : setupAccount();
        return;
      }
      const host = location.hostname;
      // 放宽判定：域名后缀匹配即可（不要求 origin 完全相等），避免在 account/mina 子域上误弹 confirm
      const isAccount = location.origin === C.ACCOUNT_ORIGIN || /(^|\.)account\.xiaomi\.com$/.test(host);
      const isMina = host === C.MINA_HOST || /(^|\.)mina\.mi\.com$/.test(host);
      log("init: host=" + host + " origin=" + location.origin +
          " → account=" + isAccount + " mina=" + isMina);
      if (isAccount) {
        log("init: 命中 account 域分支");
        injectShell();
        setupAccount();
      } else if (isMina) {
        log("init: 命中 mina 域分支");
        setupMina(injectShell());
      } else {
        // 任意页面：先确认，再打开（或聚焦）控制台页。同名窗口复用 → 重复点击只会聚焦
        log("init: 普通页面分支，弹确认框并打开控制台页");
        const ok = window.confirm(
          "「播放到小爱」需要打开一个小爱云页面作为控制台。\n\n" +
          "打开后，请在刚出现的新窗口/标签页里【再点一次这个书签】来唤起控制面板。\n\n" +
          "现在打开控制台页吗？");
        if (!ok) { log("init: 用户取消"); return; }
        window.open(C.MINA_LANDING, "p2x_console");
        toast("已打开「播放到小爱」控制台标签页，请切过去再点一次书签 🔊");
      }
    } catch (e) {
      warn("init: 异常", e);
      throw e;
    }
  }

  /* ------------------------------------------------------------- 控制台页 */

  function setupMina(root) {
    log("setupMina: 开始");
    buildPanel(root);
    // 登录弹窗完成 → 重新探测（不做任何自动停止，原则：不打断在播内容）
    // 每次重绘都会替换旧监听，避免多次点书签后累积、且旧闭包操作已移除的节点
    if (window.__p2xMsgHandler) window.removeEventListener("message", window.__p2xMsgHandler);
    window.__p2xMsgHandler = (e) => {
      if (e.origin === C.ACCOUNT_ORIGIN && e.data?.type === "p2x:login-done") {
        log("setupMina: 收到登录完成消息，重新探测");
        probe();
      }
    };
    window.addEventListener("message", window.__p2xMsgHandler);
    // 登录页用 <a target=_blank rel=noopener> 打开，opener 为 null → postMessage 收不到，
    // 所以切回本页时再兜一次：若仍在登录视图就重试 device_list。
    if (window.__p2xFocusHandler) window.removeEventListener("focus", window.__p2xFocusHandler);
    window.__p2xFocusHandler = () => {
      const loginOn = $('.p2x-view[data-view-name="login"]')?.classList.contains("on");
      if (loginOn) { log("setupMina: 回到页面，重试 device_list"); probe(); }
    };
    window.addEventListener("focus", window.__p2xFocusHandler);
    setView("loading");
    probe();
  }

  /** 登录成功后关掉「去扫码登录」打开的窗口（用 window.open 才有句柄） */
  function closeLoginWin() {
    const w = state.loginWin;
    state.loginWin = null;
    if (w && !w.closed) {
      try { w.close(); log("closeLoginWin: 已关闭登录页窗口"); }
      catch (e) { warn("closeLoginWin: 关闭失败（可手动关闭）", e?.message || e); }
    }
  }

  async function probe() {
    log("probe: 开始拉取设备列表");
    setView("loading");
    $(q.load).textContent = "正在连接小爱云…";
    try {
      state.devices = await state.mina.deviceList();      log("probe: 成功，设备数 =", state.devices.length);
      renderDevices();
      setView("main");
      closeLoginWin();
      refreshStatus(); // 面板打开即读当前播放状态，不动音箱
    } catch (e) {
      warn("probe: device_list 失败，切到登录视图 →", e?.message || e);
      setView("login");
    }
  }

  function renderDevices() {
    const sel = $(q.device);
    sel.innerHTML = "";
    if (!state.devices.length) {
      sel.append(new Option("（无主账号设备）", ""));
      state.selected = "";
      log("renderDevices: 无设备");
      return;
    }
    const remembered = localStorage.getItem(KEY_DEVICE);
    for (const d of state.devices) {
      if (!d.deviceID) continue;
      sel.append(new Option(`${d.alias || d.name}（${d.hardware || "?"}）`, d.deviceID));
    }
    state.selected = [...sel.options].some((o) => o.value === remembered)
      ? remembered : sel.options[0]?.value || "";
    sel.value = state.selected;
    state.pauseSupported = undefined; // 设备表刷新可能改变选中设备，重测暂停能力
    log("renderDevices: 可选项 =", sel.options.length, "，选中 =", state.selected);
  }

  function friendlyStatus(resp) {
    const data = resp?.data ?? resp ?? {};
    const raw = data?.status ?? "未知";
    const num = Number(raw);
    const text = (Number.isFinite(num) && STATUS_TEXT[num] !== undefined)
      ? STATUS_TEXT[num] : `未知状态 ${JSON.stringify(raw)}`;
    return { text, data };
  }

  async function refreshStatus() {
    if (!state.selected) return;
    log("refreshStatus: device =", state.selected);
    try {
      const resp = await state.mina.getStatus(state.selected);
      const { text, data } = friendlyStatus(resp);
      // 不单独做状态 UI：直接打到运行日志（含 data.info 解码后的详情）
      log("refreshStatus: OK →", data && data.status !== undefined ? text : "（无 data.status，详情见下）");
      const info = resp?.data?.info;
      if (typeof info === "string") {
        try { log("播放详情:\n" + JSON.stringify(JSON.parse(info), null, 2)); }
        catch (_) { log("播放详情:", info); }
      }
      showRaw(resp);
    } catch (e) {
      warn("refreshStatus: 失败 →", e?.message || e);
      if (e?.kind === "api") setView("login");
    }
  }

  function onButton(actName) {
    log("onButton:", actName);
    switch (actName) {
      case "play": act("play"); break;
      case "tts": act("tts"); break;
      case "tts2": act("tts2"); break;
      case "pause": act("pause"); break;
      case "stop": act("stop"); break;
      case "vol": act("vol"); break;
      case "status": refreshStatus(); break;
      case "devs": probe(); break;
    }
  }

  /** 动作执行：play/tts/pause/stop/vol（含防连点锁） */
  async function act(name) {
    if (busy) { setMsg("上一个操作还在执行…", true); return; }
    const did = state.selected;
    const setBusy = (b) => (busy = b);
    log("act:", name, "device =", did || "(未选)");
    setBusy(true);
    try {
      switch (name) {
        case "play": {
          const url = (loadData("url") || "").trim();
          if (!/^https?:\/\//.test(url)) { setMsg("请输入 http(s):// 开头的地址", true); return; }
          if (!did) { setMsg("先选设备", true); return; }
          setMsg("下发播放指令…");
          const r = await state.mina.playUrl(did, url);
          setMsg(`下发完成 code=${JSON.stringify(r?.data?.code ?? r?.code)}`);
          showRaw(r);
          setTimeout(refreshStatus, 2000); // 云端异步生效，稍后回读状态
          break;
        }
        case "tts":
        case "tts2": {
          const text = (loadData("tts") || "").trim();
          if (!text) { setMsg("输入要播报的文字", true); return; }
          if (!did) { setMsg("先选设备", true); return; }
          // 不发 player_play_operation stop：直接下发 TTS（云端异步代发，不需要先停流）
          const alt = name === "tts2";
          setMsg(alt ? "下发备用播报（ai_tts_request）…" : "下发播报指令…");
          const r = alt ? await state.mina.aiTts(did, text) : await state.mina.tts(did, text);
          setMsg(alt ? "备用播报已下发（ai_tts_request）" : "播报指令已下发");
          showRaw(r);
          break;
        }
        case "pause": {
          const action = state.pauseSupported === false ? "play" : "pause";
          const { supported } = await state.mina.playOperation(did, action);
          state.pauseSupported = supported;
          if (supported) setMsg(`${action === "pause" ? "暂停" : "继续"}指令已下发`);
          else { setMsg("该设备似乎不支持暂停（试试《停止》按钮）", true); state.pauseSupported = undefined; }
          break;
        }
        case "stop": {
          await state.mina.stop(did);
          setMsg("已下发停止");
          break;
        }
        case "vol": {
          const v = Number($(q.vol).value);
          if (!Number.isFinite(v)) return;
          await state.mina.setVolume(did, v);
          setMsg(`音量已设定为 ${v}`);
          break;
        }
        default: return;
      }
    } catch (e) {
      warn("act:", name, "失败 →", e?.message || e, e?.body || "");
      setMsg(`操作失败：${e?.message || e}${e?.body ? " · " + e.body : ""}`, true);
      if (e?.kind === "api") { showRaw(e); setView("login"); }
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------------- 登录页 */

  function setupAccount() {
    log("setupAccount: 开始");
    const root = document.getElementById("p2x-root");
    state.panel = root; // 让 $() 有根
    root.append(
      el("div", { className: "p2x-head" }, "🔐 小爱云登录"),
      el("div", { className: "p2x-body" },
        el("div", { className: "p2x-status", data: { phase: "" } }, "正在检查登录状态…"),
        el("div", { className: "p2x-status err", data: { err: "" }, hidden: "" }),
        el("div", { className: "p2x-qr", data: { qrbox: "" }, hidden: "" }),
        el("div", { className: "p2x-note", data: { qrurl: "" }, hidden: "" }),
        el("div", { className: "p2x-status", data: { done: "" }, hidden: "" })),
      el("div", { className: "p2x-logtitle", text: "运行日志" }),
      el("div", { className: "p2x-log", data: { log: "" } }),
      el("div", { className: "p2x-foot" },
        el("span", { text: "登录只发生在你的浏览器里，服务器不经手凭证" })),
    );
    logBox = $(q.log);
    flushLogs();
    runLogin();
  }

  async function runLogin() {
    const root = state.panel;
    const phase = $('[data-phase=""]', root);
    const err = $('[data-err=""]', root);
    const qrbox = $('[data-qrbox=""]', root);
    const qrurl = $('[data-qrurl=""]', root);
    const done = $('[data-done=""]', root);
    err.hidden = true; qrbox.hidden = true; qrurl.hidden = true; done.hidden = true;
    phase.textContent = "正在与小米账号服务端协商…";

    state.abortLogin?.abort();
    state.abortLogin = new AbortController();
    const signal = state.abortLogin.signal;
    log("runLogin: 开始登录流程");
    try {
      const result = await C.loginMina({
        signal,
        onQr: (stage) => {
          log("runLogin: 收到二维码阶段（官方图：" + (stage.qr ? "有" : "无") + "）");
          qrbox.hidden = false;
          qrbox.replaceChildren();
          // 与 python 版一致：优先官方 qr 图片；缺图则用公开服务按 loginUrl 现场渲染
          const src = stage.qr || (stage.loginUrl
            ? "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data="
              + encodeURIComponent(stage.loginUrl)
            : "");
          if (src) {
            qrbox.append(el("img", { src, alt: "登录二维码", width: 240, height: 240 }));
          } else {
            qrbox.append(el("div", { className: "p2x-note", text: "未取到二维码地址" }));
          }
          if (stage.loginUrl) {
            qrurl.hidden = false;
            qrurl.replaceChildren(
              el("span", { text: "扫码内容（可新窗口打开或复制）：" }),
              el("a", { href: stage.loginUrl, target: "_blank", rel: "noopener", text: stage.loginUrl }));
          }
        },
        onPhase: (t) => { log("runLogin: 阶段 →", t); phase.textContent = t; },
      });
      if (signal.aborted) return;
      log("runLogin: 成功 mode =", result.mode);
      qrbox.hidden = true; qrurl.hidden = true;
      phase.textContent = result.mode === "already"
        ? "检测到浏览器里已有有效凭证，免扫码直接换票 ✓"
        : "扫码登录并换票 ✓";
      done.hidden = false;
      done.textContent = "小爱云票已就位（浏览器已在 .mina.mi.com 域种好服务 Cookie）。" +
        "切回控制台标签页，或直接关闭本页。";
      try {
        window.opener?.postMessage({ type: "p2x:login-done" }, C.MINA_ORIGIN);
      } catch (_) { /* 控制台标签页已关也无妨，用户手动切回 */ }
    } catch (e) {
      if (signal.aborted || e?.name === "AbortError") { log("runLogin: 已取消/被新尝试取代"); return; }
      warn("runLogin: 登录失败 →", e?.message || e, e?.body || "");
      phase.textContent = "登录流程未完成";
      err.hidden = false;
      err.textContent = `${e?.message || e}${e?.body ? " · " + e.body : ""}` +
        "（可重新点一次书签重试）";
    }
  }

  /* ---------------------------------------------------------------- 轻提示 */

  // （上面已实现 toast，这里不再重复）

  /* ------------------------------------------------------------------- 启动 */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
