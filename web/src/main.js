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
    view: "",           // 当前视图名（用于回到页面时按需刷新）
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
.p2x-playing{color:#1a7f37;font-weight:600}
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
            el("a", { className: "p2x-btn primary", href: C.LOGIN_PAGE, target: "_blank", rel: "noopener" }, "🔐 打开小米官方登录页扫码"),
            el("div", { style: "height:10px" }),
            el("div", { className: "p2x-note",
              text: "在打开的官方页面里用【米家 APP】扫码即可（免密码、免短信）。扫完回到本页会自动刷新。" }))),
        // —— 视图：主面板 ——
        view("main",
          el("div", { className: "p2x-row" },
            el("label", { text: "设备" }),
            el("select", { className: "p2x-select", data: { device: "" },
              on: { change: (e) => { state.selected = e.target.value; state.pauseSupported = undefined; localStorage.setItem(KEY_DEVICE, state.selected); refreshStatus(); } } }),
            el("button", { className: "p2x-btn", title: "刷新设备列表", data: { act: "devs" } }, "⟳")),
          el("div", { className: "p2x-status", data: { playing: "" } }),
          el("div", null,
            el("input", { className: "p2x-input", data: { url: "" },
              placeholder: "http(s):// 音频地址", spellcheck: "false",
              on: { keydown: (e) => e.key === "Enter" && act("play") } }),
            el("div", { className: "p2x-row", style: "margin-top:6px" },
              el("button", { className: "p2x-btn primary", data: { act: "play" } }, "▶ 播放"),
              el("span", { className: "p2x-note", text: "直接替换在播内容，无需先手动停止" }))),
          el("div", null,
            el("input", { className: "p2x-input", data: { tts: "" }, placeholder: "要播报的文字（TTS）",
              on: { keydown: (e) => e.key === "Enter" && act("tts") } }),
            el("div", { className: "p2x-row", style: "margin-top:6px" },
              el("button", { className: "p2x-btn", data: { act: "tts" } }, "📢 播报"),
              el("span", { className: "p2x-note", text: "TTS 前自动停流并等 2 秒（云端异步代发）" }))),
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
    load: '[data-load=""]', playing: '[data-playing=""]', msg: '[data-msg=""]',
    device: "select[data-device]", url: '[data-url=""]', tts: '[data-tts=""]',
    vol: '[data-vol=""]', volv: '[data-volv=""]', raw: '[data-raw=""]',
    rawBody: '[data-rawbody=""]', log: '[data-log=""]',
  };

  /** 创建一个可切换的视图容器 */
  function view(name, ...nodes) {
    const d = el("div", { className: "p2x-view" });
    d.dataset.viewName = name;
    d.append(...nodes);
    return d;
  }

  function setView(name) {
    state.view = name;
    for (const [k, v] of Object.entries(state.views)) v.classList.toggle("on", k === name);
  }

  function setMsg(text, isErr) {
    const node = $(q.msg);
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("err", !!isErr);
  }

  function showRaw(obj) {
    const det = $(q.raw);
    det.hidden = !obj;
    $(q.rawBody).textContent = obj ? JSON.stringify(obj, null, 2) : "";
  }

  function loadData(name) { return $(`[data-${name}=""]`)?.value; }

  /* ------------------------------------------------------------- 入口分派 */

  function init() {
    log("init: 触发（href=" + location.href + "，readyState=" + document.readyState + "）");
    try {
      // 每次书签都带 ?t= 强制重新执行：直接清空原页面整页重绘，不做小窗叠加
      // 开发预览钩子：dev/preview.html 里可强制走某分支（window.__P2X_FORCE__='mina'|'account'）
      const forced = window.__P2X_FORCE__;
      if (forced === "mina" && location.host !== C.MINA_HOST) {
        log("init: dev preview 强制 mina 分支");
        setupMina(injectShell());
        return;
      }
      if (forced === "account") {
        log("init: account 分支由小米官方登录页接管，忽略");
        return;
      }
      if (location.origin === C.ACCOUNT_ORIGIN) {
        // 官方登录页自带二维码，别去动它；控制台里点「打开小米官方登录页扫码」即可
        log("init: account 域，官方登录页直接扫码，跳过注入");
        toast("官方登录页里直接扫码即可，无需在此点书签");
      } else if (location.host === C.MINA_HOST) {
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
    // 去官方登录页扫码后切回本页时自动重试（不打断在播内容）
    if (window.__p2xFocusHandler) window.removeEventListener("focus", window.__p2xFocusHandler);
    window.__p2xFocusHandler = () => {
      if (state.view === "login") { log("setupMina: 回到页面，重试 device_list"); probe(); }
    };
    window.addEventListener("focus", window.__p2xFocusHandler);
    setView("loading");
    probe();
  }

  async function probe() {
    log("probe: 开始拉取设备列表");
    setView("loading");
    $(q.load).textContent = "正在连接小爱云…";
    try {
      state.devices = await state.mina.deviceList();
      log("probe: 成功，设备数 =", state.devices.length);
      renderDevices();
      setView("main");
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
    const node = $(q.playing);
    if (!state.selected) { node.textContent = ""; return; }
    log("refreshStatus: device =", state.selected);
    try {
      const resp = await state.mina.getStatus(state.selected);
      const { text } = friendlyStatus(resp);
      node.textContent = `当前：${text}`;
      node.classList.toggle("p2x-playing", /播放中/.test(text));
      showRaw(resp);
      log("refreshStatus: OK →", text);
    } catch (e) {
      node.textContent = "状态获取失败（可能票据过期，可重新登录）";
      node.classList.remove("p2x-playing");
      if (e?.kind === "api") setView("login");
      warn("refreshStatus: 失败 →", e?.message || e);
    }
  }

  function onButton(actName) {
    log("onButton:", actName);
    switch (actName) {
      case "play": act("play"); break;
      case "tts": act("tts"); break;
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
        case "tts": {
          const text = (loadData("tts") || "").trim();
          if (!text) { setMsg("输入要播报的文字", true); return; }
          if (!did) { setMsg("先选设备", true); return; }
          // TTS 不会打断音乐流：先 stop，云端是异步代发，等 2s 再播（对照 python 版）
          setMsg("先停掉在播内容…");
          await state.mina.stop(did);
          setMsg("已下发停止，等 2 秒…");
          await C.sleep(2000);
          const r = await state.mina.tts(did, text);
          setMsg("播报指令已下发");
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

  /* ---------------------------------------------------------------- 轻提示 */

  // （上面已实现 toast，这里不再重复）

  /* ------------------------------------------------------------------- 启动 */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
