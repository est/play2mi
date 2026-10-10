/* ============================================================================
 * play2xiaomi · main.js —— 入口与界面层
 *
 * 职责：
 *   1. 按 location 分派三种执行环境：
 *      a. api2.mina.mi.com       → 控制台面板（日常使用的主界面）
 *      b. account.xiaomi.com     → 登录页（扫码/换票，完成后 postMessage 回控制台）
 *      c. 其他任意页面          → window.open 打开控制台页，轻提示"再点一次书签"
 *   2. 覆盖式 UI：注入 overlay 面板，不依赖页面任何内容；可关闭，关闭不打断
 *      音箱播放（面板从不主动 stop，仅 TTS 前按协议 stop）。
 *
 * 重复点击书签 = import() 会因 cache-busting 重新执行本文件，
 * 所以用 #p2x-root 是否存在来判定"已注入"，转而做开关切换。
 * ========================================================================== */
(() => {
  "use strict";
  const C = globalThis.P2X;
  if (!C) throw new Error("P2X 未初始化（core.js 未先行加载）");

  const KEY_DEVICE = "p2x:lastDevice";
  const STATUS_TEXT = { 1: "▶ 播放中", 0: "■ 已停止", [-1]: "- 空闲" };

  const state = {
    mina: new C.Mina(),
    devices: [],
    selected: "",
    panel: null,
    views: {},
    abortLogin: null, // 登录页长轮询的取消信号
    busy: false,      // 防止播放/播报按钮连点
    pauseSupported: undefined, // 运行时探测后缓存
  };

  /* --------------------------------------------------------------- DOM 基础 */

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k === "on") Object.entries(v).forEach(([n, f]) => node.addEventListener(n, f));
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  };
  const $ = (sel, root) => (root || state.panel).querySelector(sel);

  const css = `
#p2x-fab{position:fixed;right:16px;bottom:16px;width:46px;height:46px;border-radius:50%;
  background:rgba(24,26,32,.92);color:#ff8a3c;font-size:22px;line-height:46px;text-align:center;
  cursor:pointer;z-index:2147483000;box-shadow:0 4px 18px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.14);}
#p2x-root{position:fixed;right:16px;top:16px;width:352px;max-height:min(84vh,720px);
  background:rgba(22,24,30,.96);color:#e8eaf0;font:13px/1.5 -apple-system,"PingFang SC","Segoe UI",sans-serif;
  border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.12);
  z-index:2147483001;display:flex;flex-direction:column;overflow:hidden;}
#p2x-root *{box-sizing:border-box;}
.p2x-head{display:flex;align-items:center;gap:8px;padding:11px 14px;font-weight:600;font-size:14px;
  border-bottom:1px solid rgba(255,255,255,.08);}
.p2x-head .sp{flex:1}
.p2x-btn{cursor:pointer;padding:3px 9px;border-radius:8px;border:0;background:rgba(255,255,255,.09);
  color:inherit;font:inherit;}
.p2x-btn:hover{background:rgba(255,255,255,.18)}
.p2x-btn.primary{background:#ff6900;color:#fff}
.p2x-btn:disabled{opacity:.4;cursor:not-allowed}
.p2x-body{padding:12px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}
.p2x-row{display:flex;gap:8px;align-items:center}
.p2x-row label{flex:none;width:38px;color:#9aa0ad}
.p2x-select,.p2x-input{flex:1;min-width:0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);
  color:inherit;border-radius:8px;padding:6px 8px;font:inherit}
.p2x-input{width:100%}
.p2x-status{color:#9aa0ad;min-height:16px;font-size:12px;word-break:break-all}
.p2x-status.err{color:#ff7b72}
.p2x-playing{color:#8ce68c;font-weight:600}
.p2x-view{display:none}.p2x-view.on{display:block}
.p2x-qr{background:#fff;border-radius:10px;padding:8px;display:flex;justify-content:center;align-self:center}
.p2x-note{color:#9aa0ad;font-size:12px}
.p2x-foot{padding:8px 14px 10px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:10px;
  color:#7d838f;font-size:11px}
.p2x-link{color:#8ab4f8;cursor:pointer;text-decoration:underline}
.p2x-detail{margin:0;font-size:11px;color:#9aa0ad;word-break:break-all;white-space:pre-wrap}
.p2x-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483002;
  background:rgba(22,24,30,.96);color:#e8eaf0;padding:10px 18px;border-radius:10px;
  border:1px solid rgba(255,255,255,.12);font:13px -apple-system,"PingFang SC",sans-serif;
  box-shadow:0 8px 30px rgba(0,0,0,.5)}
`;

  function injectShell() {
    document.head.appendChild(el("style", { id: "p2x-style", text: css }));
    const fab = el("button", { id: "p2x-fab", title: "播放到小爱（点击开合）", on: { click: togglePanel } }, "🔊");
    const root = el("div", { id: "p2x-root" });
    document.body.appendChild(fab);
    document.body.appendChild(root);
    return root;
  }

  function buildPanel(root) {
    state.panel = root;
    const bar = (name) => `div[data-v="${name}"]`;
    root.innerHTML = `
      <div class="p2x-head">🔊 播放到小爱<span class="sp"></span>
        <button class="p2x-btn" data-act="min">收起</button>
      </div>
      <div class="p2x-body">
        <div class="p2x-view" ${bar("loading")}><div class="p2x-status">连接中…</div></div>

        <div class="p2x-view" ${bar("login")}>
          <div>还没有登录小爱云（或凭证过期）。</div>
          <button class="p2x-btn primary" data-act="login">🔐 扫码登录</button>
          <div class="p2x-note">会打开小米账号登录页，用【米家 APP】扫码即可（免密码、免短信）。
            登录完成后自动回到本面板。</div>
        </div>

        <div class="p2x-view" ${bar("main")}>
          <div class="p2x-row">
            <label>设备</label>
            <select class="p2x-select" data-sel="device"></select>
            <button class="p2x-btn" data-act="devs" title="刷新设备列表">⟳</button>
          </div>
          <div class="p2x-status" data-sel="playing"></div>
          <div>
            <input class="p2x-input" data-sel="url" placeholder="http(s):// 音频地址" spellcheck="false"/>
            <div class="p2x-row" style="margin-top:6px">
              <button class="p2x-btn primary" data-act="play">▶ 播放</button>
              <span class="p2x-note">直接替换当前播放，不打断自己在播的内容之前无需手动停止</span>
            </div>
          </div>
          <div>
            <input class="p2x-input" data-sel="tts" placeholder="要播报的文字（TTS）"/>
            <div class="p2x-row" style="margin-top:6px">
              <button class="p2x-btn" data-act="tts">📢 播报</button>
              <span class="p2x-note">TTS 前会自动停流并等 2 秒（云端异步代发）</span>
            </div>
          </div>
          <div class="p2x-row">
            <label>音量</label>
            <input data-sel="vol" type="range" min="0" max="100" />
            <span data-sel="volv" style="width:34px;text-align:right"></span>
            <button class="p2x-btn" data-act="vol">设定</button>
          </div>
          <div class="p2x-row">
            <button class="p2x-btn" data-act="pause">⏸ 暂停/继续</button>
            <button class="p2x-btn" data-act="stop">■ 停止</button>
            <button class="p2x-btn" data-act="status">↻ 状态</button>
          </div>
          <details class="p2x-detail" data-sel="raw" hidden><summary>最近一次响应</summary><div></div></details>
          <div class="p2x-status" data-sel="msg"></div>
        </div>
      </div>
      <div class="p2x-foot">
        <span class="p2x-link" data-act="relogin">重新登录</span>
        <span style="flex:1"></span>
        <span>无服务器 · 浏览器直连</span>
      </div>`;

    root.querySelector(".p2x-head .p2x-btn, [data-act=min]").addEventListener("click", togglePanel);
    root.addEventListener("click", onPanelClick);
    $("select[data-sel=device]", root).addEventListener("change", (e) => {
      localStorage.setItem(KEY_DEVICE, state.selected = e.target.value);
      refreshStatus();
    });
    $("input[data-sel=vol]", root).addEventListener("input", (e) => {
      $("[data-sel=volv]", root).textContent = e.target.value;
    });
    $("input[data-sel=url]", root).addEventListener("keydown", (e) => {
      if (e.key === "Enter") onPanelAction("play");
    });
    $("input[data-sel=tts]", root).addEventListener("keydown", (e) => {
      if (e.key === "Enter") onPanelAction("tts");
    });
    for (const v of root.querySelectorAll(".p2x-view")) state.views[v.dataset.v] = v;
  }

  const setView = (name) => {
    for (const [k, v] of Object.entries(state.views)) v.classList.toggle("on", k === name);
  };

  function setMsg(text, isErr) {
    const node = $("[data-sel=msg]");
    if (node) {
      node.textContent = text || "";
      node.classList.toggle("err", !!isErr);
    }
  }

  function showRaw(respObj) {
    const det = $("[data-sel=raw]");
    det.hidden = !respObj;
    det.querySelector("div").textContent = JSON.stringify(respObj, null, 2);
  }

  /* ------------------------------------------------------------- 入口分派 */

  function init() {
    if (document.getElementById("p2x-root")) { togglePanel(); return; } // 已注入 → 开合
    if (location.origin === C.ACCOUNT_ORIGIN) {
      injectShell();
      setupAccount();
    } else if (location.host === C.MINA_HOST) {
      const root = injectShell();
      setupMina(root);
    } else {
      // 任意页面：打开控制台页（若没有 player 票，控制台页自己会引导登录）
      if (window.__P2X_OPENED__) return; // 防手上多连点反复开窗
      window.__P2X_OPENED__ = true;
      window.open(C.MINA_LANDING, "p2x_console");
      toast("已打开「播放到小爱」控制台标签页，请在新页面上再点一次书签 🔊");
    }
  }

  function togglePanel() {
    const root = document.getElementById("p2x-root");
    if (root) root.style.display = root.style.display === "none" ? "flex" : "none";
  }

  function toast(text, ms = 5200) {
    const t = el("div", { className: "p2x-toast", text }, "​");
    t.firstChild.remove(); // el() 的 text 走 attrs 不走 children；补一层
    t.textContent = typeof text === "string" ? text : String(text);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  /* ------------------------------------------------------------- 控制台页 */

  function setupMina(root) {
    buildPanel(root);
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
    $("[data-v=loading] .p2x-status").textContent = "正在连接小爱云…";
    try {
      const devs = await state.mina.deviceList();
      state.devices = devs;
      renderDevices();
      setView("main");
      refreshStatus(); // 初次打开探测播放状态，绝不打断在播的内容
    } catch (e) {
      showLoginNeeded(e);
    }
  }

  function showLoginNeeded(e) {
    setView("login");
    console.warn("[p2x] 连接失败", e);
  }

  function renderDevices() {
    const sel = $("select[data-sel=device]");
    if (!state.devices.length) {
      sel.innerHTML = "";
      sel.appendChild(new Option("（无主账号设备）", ""));
      return;
    }
    sel.innerHTML = "";
    for (const d of state.devices) {
      if (!d.deviceID) continue;
      const label = `${d.alias || d.name}（${d.hardware || "?"}）`;
      sel.appendChild(new Option(label, d.deviceID));
    }
    const remembered = localStorage.getItem(KEY_DEVICE);
    const preferred = state.devices.some((d) => d.deviceID === remembered)
      ? remembered
      : state.devices.find((d) => d.deviceID)?.deviceID || "";
    state.selected = preferred;
    sel.value = preferred;
  }

  function friendlyStatus(resp) {
    const data = resp?.data ?? {};
    const raw = data?.status ?? data;
    const num = Number(raw);
    const text = Number.isFinite(num) && STATUS_TEXT[num] !== undefined
      ? STATUS_TEXT[num] : `未知状态 ${JSON.stringify(raw)}`;
    return { text, data };
  }

  async function refreshStatus() {
    const did = state.selected;
    if (!did) return;
    try {
      const resp = await state.mina.getStatus(did);
      const { text, data } = friendlyStatus(resp);
      const node = $("p2x-playing-node") ? $("[data-sel=playing]") : $("[data-sel=playing]");
      node.textContent = `当前：${text}`;
      node.classList.toggle("p2x-playing", /播放中/.test(text));
      showRaw(resp);
      state.pauseSupported = undefined; // 随状态变化重新探测
      console.info("[p2x] status 详情", data);
    } catch (e) {
      const node = $("[data-sel=playing]");
      node.textContent = "状态获取失败（可能票据过期，可重新登录）";
      node.classList.remove("p2x-playing");
      if (e?.kind === "api") showLoginNeeded(e);
    }
  }

  function guard() {
    if (state.busy) return false;
    if (!state.selected) { setMsg("请先选择设备", true); return false; }
    return (state.busy = true);
  }

  async function onPanelAction(act) {
    const root = state.panel;
    const did = state.selected;
    const urlInput = $("[data-sel=url]", root);
    const ttsInput = $("[data-sel=tts]", root);
    try {
      switch (act) {
        case "play": {
          const url = urlInput.value.trim();
          if (!/^https?:\:\/\//.test(url)) { setMsg("请输入 http(s):// 开头的地址", true); return; }
          if (!guard()) return;
          setMsg("下发播放指令…");
          const r = await state.mina.playUrl(did, url);
          setMsg(`下发完成 code=${JSON.stringify(r?.data?.code ?? r?.code)}`);
          showRaw(r);
          setTimeout(refreshStatus, 2000); // 云端异步生效，稍后回读
          break;
        }
        case "tts": {
          const text = ttsInput.value.trim();
          if (!text) { setMsg("输入要播报的文字", true); return; }
          if (!guard()) return;
          setMsg("先停掉在播内容…");
          await state.mina.stop(did);
          setMsg("已下发停止，等 2 秒…");       // 云端是异步代发，等稳态再发起 TTS
          await C.sleep(2000);
          const r = await state.mina.tts(did, text);
          setMsg("播报指令已下发");
          showRaw(r);
          break;
        }
        case "pause": {
          const action = state.pauseSupported === false ? "play" : "pause";
          await state.mina.playOperation(did, action);
          setMsg(`${action === "pause" ? "暂停" : "继续"}指令已下发`);
          break;
        }
        case "stop": {
          await state.mina.stop(did);
          setMsg("已下发停止");
          break;
        }
        case "status":
          await refreshStatus();
          return;
        case "vol": {
          const v = Number($("[data-sel=vol]", root).value);
          await state.mina.setVolume(did, v);
          setMsg(`音量已设定为 ${v}`);
          break;
        }
        case "devs":
          await probe();
          return;
        default:
          return;
      }
    } catch (e) {
      setMsg(`操作失败：${e.message || e}`, true);
      if (e?.kind === "api") { showRaw(e); showLoginNeeded(e); }
    } finally {
      state.busy = false;
    }
  }

  function onPanelClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (["min", "relogin", "login"].includes(act)) {
      if (act === "login") openLoginPopup();
      if (act === "relogin") openLoginPopup(true);
      return;
    }
    onPanelAction(act);
  }

  function openLoginPopup() {
    window.open(C.LOGIN_PAGE, "p2x_login", "width=480,height=720");
  }

  /* --------------------------------------------------------------- 登录页 */

  function setupAccount() {
    const root = document.getElementById("p2x-root");
    root.innerHTML = `
      <div class="p2x-head">🔐 小爱云登录<span class="sp"></span>
        <button class="p2x-btn" data-act="acc-min">收起</button></div>
      <div class="p2x-body">
        <div class="p2x-status" data-sel="phase">正在检查登录状态…</div>
        <div class="p2x-status err" data-sel="err" hidden></div>
        <div class="p2x-qr" data-sel="qr" hidden></div>
        <div class="p2x-note" data-sel="url" hidden></div>
        <div class="p2x-view">
          <div class="p2x-status" data-sel="done" hidden>✓ 已就绪</div>
        </div>
        <div class="p2x-row" data-sel="btns" hidden>
          <button class="p2x-btn" data-act="acc-close">✕ 关闭此窗口</button>
          <button class="p2x-btn" data-act="_acc-cancel" hidden>取消等待</button>
          <button class="p2x-btn primary" data-act="acc-retry" hidden>重试</button>
        </div>
      </div>
      <div class="p2x-foot"><span>登录只发生在你的浏览器里，服务器不经手凭证</span></div>`;
    root.querySelector("[data-act~=\"acc-min\"]").addEventListener("click", togglePanel);
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "acc-close") window.close();
      if (act === "acc-retry") { resetAccountView(); runAccountLogin(); }
      if (act === "acc-cancel") state.abortLogin?.abort();
    });
    runAccountLogin();
  }

  function resetAccountView() {
    const root = state.sectionAccountRoot || document.getElementById("p2x-root");
    $("[data-sel=err]", root).hidden = true;
    $("[data-sel=qr]", root).hidden = true;
    $("[data-sel=qr]", root).innerHTML = "";
    $("[data-sel=url]", root).hidden = true;
    $("[data-sel=done]", root).hidden = true;
    $("[data-sel=btns]", root).hidden = false;
    $("[data-act=acc-retry]", root).hidden = true;
    $("[data-act=_acc-cancel]", root).hidden = false;
  }

  function accountFail(message) {
    const root = document.getElementById("p2x-root");
    $("[data-sel=phase]", root).textContent = "登录流程未完成";
    const err = $("[data-sel=err]", root);
    err.hidden = false;
    err.textContent = message + "（如果你在别的窗口已登录过，直接关掉本页即可）";
    $("[data-act=acc-retry]", root).hidden = false;
    $("[data-act=_acc-cancel]", root).hidden = true;
  }

  function renderQr(stage, phase) {
    const root = document.getElementById("p2x-root");
    const box = $("[data-sel=qr]", root);
    box.hidden = false;
    box.innerHTML = "";
    box.appendChild(el("div", { text: phase || "", className: "p2x-note", style: "margin-bottom:4px" }));
    const img = el("img", { src: stage.qr, alt: "登录二维码", width: 240, height: 240 });
    box.appendChild(img);
    img.addEventListener("error", () => { // 官方图缺省 → 用内置生成器的兜底
      img.remove();
      const canvas = el("canvas");
      const qr = C.qrGenerate(stage.loginUrl);
      const scale = 5, margin = 3;
      const px = (qr.size + margin * 2) * scale;
      canvas.width = canvas.height = px;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = "#000";
      qr.modules.forEach((row, y) => row.forEach((dark, x) => {
        if (dark) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
      }));
      canvas.style.imageRendering = "pixelated";
      box.appendChild(canvas);
    });
    const url = $("[data-sel=url]", root);
    url.hidden = false;
    url.textContent = "扫码内容：" + stage.loginUrl;
  }

  async function runAccountLogin() {
    const root = document.getElementById("p2x-root");
    const phase = $("[data-sel=phase]", root);
    state.abortLogin?.abort();
    state.abortLogin = new AbortController();
    const signal = state.abortLogin.signal;
    try {
      const result = await C.loginMina({
        signal,
        onQr: (stage) => renderQr(stage, "请用【米家 APP】扫码（免密码、免短信）"),
        onPhase: (t) => {
          if (!stageStillShowing()) throw undefined;
          phase.textContent = t;
        },
      });
      if (signal.aborted) return;
      $("[data-sel=qr]", root).hidden = true;
      $("[data-sel=url]", root).hidden = true;
      phase.textContent = result.mode === "already"
        ? "检测到已有登录凭证，免扫码换票完成 ✓"
        : "扫码登录并换票完成 ✓";
      const done = $("[data-sel=done]", root);
      done.hidden = false;
      done.textContent = "小爱云凭证已就位（自动写进浏览器的小米域 Cookie）。切回控制台标签页即可。";
      $("[data-act=acc-retry]", root).hidden = false;
      $("[data-act=_acc-cancel]", root).hidden = true;
      try {
        window.opener?.postMessage({ type: "p2x:login-done" }, C.MINA_ORIGIN);
      } catch (_) { /* 与控制台页失联也无妨，用户手动切回 */ }
    } catch (e) {
      if (e?.name === "AbortError") {
        phase.textContent = "等待已取消";
        $("[data-act=acc-retry]", root).hidden = false;
        return;
      }
      console.warn("[p2x] login fail", e);
      accountFail(`${e?.message || e}${e?.body ? " · " + e.body : ""}`);
    }
  }

  function stageStillShowing() {
    // 登录页里二维码渲染后不再需要 thrash phase 文本；简单恒真
    return true;
  }

  /* ---------------------------------------------------------------- 轻提示 */

  /* ------------------------------------------------------------------- 启动 */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
