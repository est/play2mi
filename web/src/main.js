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
  const C = globalThis.P2X;
  if (!C) throw new Error("P2X 未初始化（core.js 未先行加载）");

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
    pauseSupported: undefined, // 运行时探测结果缓存
  };

  /* --------------------------------------------------------------- DOM 基础 */

  let busy = false; // 防止播放/播报按钮连点

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
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

  const css = `
#p2x-fab{position:fixed;right:16px;bottom:16px;width:46px;height:46px;border-radius:50%;
  background:rgba(24,26,32,.92);color:#ff8a3c;font-size:22px;line-height:46px;text-align:center;
  cursor:pointer;z-index:2147483000;box-shadow:0 4px 18px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.14);}
#p2x-root{position:fixed;right:16px;top:16px;width:352px;max-height:min(86vh,740px);
  background:rgba(22,24,30,.96);color:#e8eaf0;font:13px/1.5 -apple-system,"PingFang SC","Segoe UI",sans-serif;
  border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.12);
  z-index:2147483001;display:flex;flex-direction:column;overflow:hidden;}
#p2x-root *{box-sizing:border-box;}
.p2x-head{display:flex;align-items:center;gap:8px;padding:11px 14px;font-weight:600;font-size:14px;
  border-bottom:1px solid rgba(255,255,255,.08);}
.p2x-head .sp{flex:1}
.p2x-btn{cursor:pointer;padding:3px 9px;border-radius:8px;border:0;background:rgba(255,255,255,.09);
  color:inherit;font:inherit;white-space:nowrap}
.p2x-btn:hover{background:rgba(255,255,255,.18)}
.p2x-btn.primary{background:#ff6900;color:#fff}
.p2x-btn:disabled{opacity:.4;cursor:not-allowed}
.p2x-body{padding:12px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}
.p2x-row{display:flex;gap:8px;align-items:center}
.p2x-row label{flex:none;color:#9aa0ad}
.p2x-select,.p2x-input{flex:1;min-width:0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);
  color:inherit;border-radius:8px;padding:6px 8px;font:inherit;width:100%}
.p2x-status{color:#9aa0ad;min-height:16px;font-size:12px;word-break:break-all}
.p2x-status.err{color:#ff7b72}
.p2x-playing{color:#8ce68c;font-weight:600}
.p2x-view{display:none}.p2x-view.on{display:block}
.p2x-note{color:#9aa0ad;font-size:11.5px}
.p2x-qr{background:#fff;border-radius:10px;padding:10px;display:flex;flex-direction:column;
  align-items:center;gap:4px;align-self:center}
.p2x-qr canvas{image-rendering:pixelated}
.p2x-foot{padding:8px 14px 10px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:10px;
  color:#7d838f;font-size:11px;align-items:center}
.p2x-link{color:#8ab4f8;cursor:pointer;text-decoration:underline}
.p2x-detail{margin:0;font-size:11px;color:#9aa0ad;word-break:break-all;white-space:pre-wrap}
.p2x-detail summary{cursor:pointer}
.p2x-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483002;
  background:rgba(22,24,30,.96);color:#e8eaf0;padding:10px 18px;border-radius:10px;
  border:1px solid rgba(255,255,255,.12);font:13px -apple-system,"PingFang SC",sans-serif;
  box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:70vw}
`;

  function injectShell() {
    document.head.append(el("style", { id: "p2x-style", text: css }));
    const fab = el("button", {
      id: "p2x-fab", title: "播放到小爱（点击开合）",
      on: { click: togglePanel },
    }, "🔊");
    const root = el("div", { id: "p2x-root" });
    document.body.append(fab, root);
    return root;
  }

  function togglePanel() {
    const root = document.getElementById("p2x-root");
    if (root) root.style.display = root.style.display === "none" ? "flex" : "none";
  }

  function toast(text, ms = 5200) {
    const t = el("div", { className: "p2x-toast", text });
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }

  /* ------------------------------------------------------------- 控制台面板 */

  function buildPanel(root) {
    state.panel = root;
    root.append(
      el("div", { className: "p2x-head" },
        "🔊 播放到小爱",
        el("span", { className: "sp" }),
        el("button", { className: "p2x-btn", data: { act: "min" } }, "收起")),
      el("div", { className: "p2x-body", data: { body: "" } },
        // —— 视图：加载中 ——
        view("loading", el("div", { className: "p2x-status", data: { load: "" } }, "连接中…")),
        // —— 视图：需要登录 ——
        view("login",
          el("div", null,
            el("div", { text: "还没有登录小爱云（或凭证过期）。" }),
            el("div", { style: "height:8px" }),
            el("button", { className: "p2x-btn primary", data: { act: "login" } }, "🔐 扫码登录"),
            el("div", { style: "height:8px" }),
            el("div", { className: "p2x-note",
              text: "会打开小米账号登录页，用【米家 APP】扫码即可（免密码、免短信）。登录完成后自动回到本面板。" }))),
        // —— 视图：主面板 ——
        view("main",
          el("div", { className: "p2x-row" },
            el("label", { text: "设备" }),
            el("select", { className: "p2x-select", data: { device: "" },
              on: { change: (e) => { state.selected = e.target.value; localStorage.setItem(KEY_DEVICE, state.selected); refreshStatus(); } } }),
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
      el("div", { className: "p2x-foot" },
        el("span", { className: "p2x-link", data: { act: "relogin" }, text: "重新登录" }),
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
  }

  const q = {
    view: (n) => `.p2x-view[data-view-name="${n}"]`,
    load: '[data-load=""]', playing: '[data-playing=""]', msg: '[data-msg=""]',
    device: "select[data-device]", url: '[data-url=""]', tts: '[data-tts=""]',
    vol: '[data-vol=""]', volv: '[data-volv=""]', raw: '[data-raw=""]',
    rawBody: '[data-rawbody=""]',
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

  function showRaw(obj) {
    const det = $(q.raw);
    det.hidden = !obj;
    $(q.rawBody).textContent = obj ? JSON.stringify(obj, null, 2) : "";
  }

  function loadData(name) { return $(`[data-${name}=""]`)?.value; }

  /* ------------------------------------------------------------- 入口分派 */

  function init() {
    if (document.getElementById("p2x-root")) { togglePanel(); return; }
    // 开发预览钩子：dev/preview.html 里可强制走某分支（window.__P2X_FORCE__='mina'|'account'）
    const forced = window.__P2X_FORCE__;
    if ((forced === "mina" && location.host !== C.MINA_HOST) ||
        (forced === "account" && location.origin !== C.ACCOUNT_ORIGIN)) {
      const root = injectShell();
      forced === "mina" ? setupMina(root) : setupAccount();
      console.info("[p2x] dev preview 强制分支：" + forced);
      return;
    }
    if (location.origin === C.ACCOUNT_ORIGIN) {
      injectShell();
      setupAccount();
    } else if (location.host === C.MINA_HOST) {
      setupMina(injectShell());
    } else {
      // 任意页面：打开（或聚焦）控制台页。同名窗口复用 → 重复点击只会聚焦
      window.open(C.MINA_LANDING, "p2x_console");
      toast("已打开「播放到小爱」控制台标签页，请在那个页面上再点一次书签 🔊");
    }
  }

  /* ------------------------------------------------------------- 控制台页 */

  function setupMina(root) {
    buildPanel(root);
    // 登录弹窗完成 → 重新探测（不做任何自动停止，原则：不打断在播内容）
    window.addEventListener("message", (e) => {
      if (e.origin === C.ACCOUNT_ORIGIN && e.data?.type === "p2x:login-done") {
        console.info("[p2x] 登录完成，重新探测");
        probe();
      }
    });
    setView("loading");
    probe();
  }

  async function probe() {
    setView("loading");
    $(q.load).textContent = "正在连接小爱云…";
    try {
      state.devices = await state.mina.deviceList();
      renderDevices();
      setView("main");
      refreshStatus(); // 面板打开即读当前播放状态，不动音箱
    } catch (e) {
      console.warn("[p2x] device_list 失败", e);
      setView("login");
    }
  }

  function renderDevices() {
    const sel = $(q.device);
    sel.innerHTML = "";
    if (!state.devices.length) {
      sel.append(new Option("（无主账号设备）", ""));
      state.selected = "";
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
    try {
      const resp = await state.mina.getStatus(state.selected);
      const { text } = friendlyStatus(resp);
      node.textContent = `当前：${text}`;
      node.classList.toggle("p2x-playing", /播放中/.test(text));
      showRaw(resp);
      state.pauseSupported = undefined; // 状态变化后重测暂停能力
    } catch (e) {
      node.textContent = "状态获取失败（可能票据过期，可重新登录）";
      node.classList.remove("p2x-playing");
      if (e?.kind === "api") setView("login");
      console.warn("[p2x] status 失败", e);
    }
  }

  function onButton(actName) {
    if (actName === "min") { togglePanel(); return; }
    if (actName === "login" || actName === "relogin") {
      window.open(C.LOGIN_PAGE, "p2x_login", "width=480,height=720");
      return;
    }
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
      setMsg(`操作失败：${e?.message || e}${e?.body ? " · " + e.body : ""}`, true);
      if (e?.kind === "api") { showRaw(e); setView("login"); }
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------------- 登录页 */

  function setupAccount() {
    const root = document.getElementById("p2x-root");
    state.panel = root; // 让 $() 有根
    root.append(
      el("div", { className: "p2x-head" }, "🔐 小爱云登录",
        el("span", { className: "sp" }),
        el("button", { className: "p2x-btn", on: { click: togglePanel } }, "收起")),
      el("div", { className: "p2x-body" },
        el("div", { className: "p2x-status", data: { phase: "" } }, "正在检查登录状态…"),
        el("div", { className: "p2x-status err", data: { err: "" }, hidden: "" }),
        el("div", { className: "p2x-qr", data: { qrbox: "" }, hidden: "" }),
        el("div", { className: "p2x-note", data: { qrurl: "" }, hidden: "" }),
        el("div", { className: "p2x-status", data: { done: "" }, hidden: "" }),
        el("div", { className: "p2x-row", data: { btns: "" }, hidden: "" },
          el("button", { className: "p2x-btn", data: { acct: "close" } }, "✕ 关闭此窗口"),
          el("button", { className: "p2x-btn", data: { acct: "cancel" }, hidden: "" }, "取消等待"),
          el("button", { className: "p2x-btn primary", data: { acct: "retry" }, hidden: "" }, "重试"))),
      el("div", { className: "p2x-foot" },
        el("span", { text: "登录只发生在你的浏览器里，服务器不经手凭证" })),
    );
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-acct]");
      if (!btn) return;
      switch (btn.dataset.acct) {
        case "close": window.close(); break;
        case "cancel": {
          state.abortLogin?.abort();
          const phase = $('[data-phase=""]', state.panel);
          if (phase) {
            phase.textContent = "等待已取消";
            $('[data-acct="cancel"]', state.panel).hidden = true;
            $('[data-acct="retry"]', state.panel).hidden = false;
          }
          break;
        }
        case "retry": runLogin(); break;
      }
    });
    runLogin();
  }

  async function runLogin() {
    const root = state.panel;
    const phase = $('[data-phase=""]', root);
    const err = $('[data-err=""]', root);
    const btnCancel = $('[data-acct="cancel"]', root);
    const btnRetry = $('[data-acct="retry"]', root);
    const qrbox = $('[data-qrbox=""]', root);
    const qrurl = $('[data-qrurl=""]', root);
    const done = $('[data-done=""]', root);
    err.hidden = true; qrbox.hidden = true; qrurl.hidden = true; done.hidden = true;
    btnRetry.hidden = true; btnCancel.hidden = false;
    phase.textContent = "正在与小米账号服务端协商…";

    state.abortLogin?.abort();
    state.abortLogin = new AbortController();
    const signal = state.abortLogin.signal;
    try {
      const result = await C.loginMina({
        signal,
        onQr: (stage) => {
          qrbox.hidden = false;
          qrbox.innerHTML = "";
          qrbox.append(el("div", { className: "p2x-note", text: "请用【米家 APP】扫码（免密码、免短信）" }));
          const canvasFromUrl = () => { // 官方图缺省 → 用内置 QR 生成器兜底
            const qrMatrix = C.qrGenerate(stage.loginUrl);
            const scale = 5, margin = 3;
            const px = (qrMatrix.size + margin * 2) * scale;
            const canvas = el("canvas");
            canvas.width = canvas.height = px;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, px, px);
            ctx.fillStyle = "#000";
            qrMatrix.modules.forEach((row, y) => row.forEach((dark, x) => {
              if (dark) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
            }));
            qrbox.append(canvas);
          };
          if (stage.qr) {
            const img = el("img", { src: stage.qr, alt: "登录二维码", width: 240, height: 240,
              onerror: () => { img.remove(); canvasFromUrl(); } });
            qrbox.append(img);
          } else {
            canvasFromUrl();
          }
          qrurl.hidden = false;
          qrurl.textContent = "扫码内容：" + stage.loginUrl;
        },
        onPhase: (t) => (phase.textContent = t),
      });
      if (signal.aborted) return;
      qrbox.hidden = true; qrurl.hidden = true; btnCancel.hidden = true; btnRetry.hidden = false;
      phase.textContent = result.mode === "already"
        ? "检测到浏览器里已有有效凭证，免扫码直接换票 ✓"
        : "扫码登录并换票 ✓";
      done.hidden = false;
      done.textContent = "小爱云票已就位（浏览器已在 .mina.mi.com 域种好服务 Cookie）。" +
        "切回控制台标签页即可。";
      try {
        window.opener?.postMessage({ type: "p2x:login-done" }, C.MINA_ORIGIN);
      } catch (_) { /* 控制台标签页已关也无妨，用户手动切回 */ }
    } catch (e) {
      if (signal.aborted || e?.name === "AbortError") return; // 旧尝试被新登录取代/取消
      console.warn("[p2x] 登录失败", e);
      phase.textContent = "登录流程未完成";
      err.hidden = false;
      err.textContent = `${e?.message || e}${e?.body ? " · " + e.body : ""}` +
        "（若浏览器里已有别的登录凭证，关掉本页重试）";
      btnRetry.hidden = false; btnCancel.hidden = true;
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
