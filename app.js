/* The app around the two tabs: sign-in, the tab bar, More, and keeping itself up to date. */
(function () {
  "use strict";
  const L = window.LE, A = window.LEAuth;
  const { $, esc } = L;
  const VERSION = "1.4.0";
  const THEME = { board: "#18211c", hub: "#0c131d" };
  let tab = L.lsGet("tab", "board");
  let started = false;

  function showGate(msg) {
    $("gate").hidden = false;
    $("tabs").hidden = true;
    $("v-board").hidden = true; $("v-hub").hidden = true;
    const ready = A.configured();
    $("signin").disabled = !ready;
    $("gate-msg").textContent = !ready ? "Almost ready. The app still needs its Microsoft registration, which Claude does with you at the laptop." : msg || "";
    document.body.className = "tab-gate";
    setTheme("#18211c");
  }
  function setTheme(c) { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", c); }
  function show(t) {
    tab = t === "hub" ? "hub" : "board";
    L.lsSet("tab", tab);
    $("gate").hidden = true;
    $("tabs").hidden = false;
    $("v-board").hidden = tab !== "board";
    $("v-hub").hidden = tab !== "hub";
    if (document.body.className !== "tab-" + tab) $("toast").hidden = true; // a message from the other tab doesn't belong here
    document.body.className = "tab-" + tab;
    setTheme(THEME[tab]);
    document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.setAttribute("aria-current", b.getAttribute("data-tab") === tab ? "page" : "false"));
    window.scrollTo({ top: 0 });
    if (tab === "board") { window.LEBoard.render(); if (window.LEBoard.stale()) window.LEBoard.load(); }
    else window.LEHub.shown();
  }
  function start() {
    if (started) { show(tab); return; }
    started = true;
    window.LEBoard.init();
    window.LEHub.init();
    show(tab);
    if (tab !== "board") window.LEBoard.load(); // so the board is fresh when you switch to it
  }

  /* Microsoft wants a fresh sign-in: try quietly first (at most once an hour), else show the sign-in screen. */
  function needSignIn() {
    if (A.configured() && A.user() && A.maySilent()) { A.silent().catch(() => showGate()); return; }
    showGate("Microsoft wants you to sign in again.");
  }

  function moreBody() {
    const u = A.user(), hub = window.LEHub.info();
    return '<dl class="kv"><dt>Signed in as</dt><dd>' + esc((u && (u.name || u.hint)) || "Not signed in") + (u && u.hint && u.name ? "<small>" + esc(u.hint) + "</small>" : "") + "</dd>" +
      "<dt>Work hub runs on</dt><dd>" + (hub.pair ? esc(hub.pair.computer) + "<small>This phone is paired with it.</small>" : "Not paired yet<small>Pair from the Work hub tab.</small>") + "</dd>" +
      "<dt>App version</dt><dd>" + VERSION + '<small id="m-upd">Up to date.</small></dd></dl>' +
      '<div class="more-acts">' + (hub.pair ? '<button type="button" class="m-btn" data-m="unpair">Unpair this phone</button>' : "") +
      '<button type="button" class="m-btn" data-m="update">Check for an update</button><button type="button" class="m-btn bad" data-m="signout">Sign out</button></div>';
  }
  async function moreAction(k) {
    if (k === "signout") {
      if (!(await L.ask("Sign out?", "The app forgets your Microsoft sign-in on this phone. Your board and pairing stay as they are.", "Sign out"))) return;
      A.signOut(); $("more").hidden = true; showGate("Signed out.");
    } else if (k === "unpair") {
      if (!(await L.ask("Unpair this phone?", "This phone forgets its pairing key, so it can't start jobs on the laptop until you pair again. On the laptop you can also press Forget in Pair my phone.", "Unpair"))) return;
      await window.LEHub.unpair(); $("more").hidden = true; L.toast("Unpaired.");
    } else if (k === "update") {
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      if (!reg) { L.toast("Updates come with each reload."); return; }
      await reg.update().catch(() => {});
      const el = $("m-upd");
      if (reg.waiting) { reg.waiting.postMessage("skip"); if (el) el.textContent = "Updating now."; }
      else if (el) el.textContent = "Up to date (checked just now).";
    }
  }

  /* ---------- events ---------- */
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const tb = t.closest("#tabs [data-tab]");
    if (tb) { show(tb.getAttribute("data-tab")); return; }
    if (t.closest("#tabs [data-more]")) { $("more-body").innerHTML = moreBody(); $("more").hidden = false; return; }
    if (t.closest("[data-mclose]")) { $("more").hidden = true; return; }
    const m = t.closest("[data-m]");
    if (m) { moreAction(m.getAttribute("data-m")); return; }
  });
  $("signin").addEventListener("click", () => { $("signin").disabled = true; A.signIn().catch((e) => { $("signin").disabled = false; $("gate-msg").textContent = L.problemFor(e); }); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!$("ask").hidden) { $("ask-no").click(); return; }
    if (!$("qs").hidden) { $("qs-no").click(); return; }
    if (!$("more").hidden) { $("more").hidden = true; return; }
    if (tab === "board") window.LEBoard.escape(); else window.LEHub.escape();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !started || !A.signedIn()) return;
    if (tab === "board" && window.LEBoard.stale() && !window.LEBoard.isOpen()) window.LEBoard.load();
    if (tab === "hub") window.LEHub.shown();
  });
  window.addEventListener("le:signin", needSignIn);
  window.addEventListener("le:counts", (e) => { const d = $("t-board-n"); const n = e.detail.you; d.hidden = !n; d.textContent = n > 99 ? "99+" : n; });
  window.addEventListener("le:hubcount", (e) => { const d = $("t-hub-n"); const n = e.detail.waiting; d.hidden = !n; d.textContent = n; });

  /* ---------- keeping the app itself up to date ---------- */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const offer = () => { if (reg.waiting && navigator.serviceWorker.controller) L.toast("A new version of the app is ready.", () => reg.waiting && reg.waiting.postMessage("skip"), false, "Update"); };
      offer();
      reg.addEventListener("updatefound", () => { const w = reg.installing; if (w) w.addEventListener("statechange", () => { if (w.state === "installed") offer(); }); });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
  }

  /* ---------- start ---------- */
  window.LEApp = { tab: () => tab, version: VERSION };
  (async () => {
    let r = null;
    try { r = await A.finish(); } catch (e) { r = { error: L.problemFor(e) }; }
    if (r && r.error) { showGate(r.error); return; }
    if (r && r.needsSignIn) { showGate(); return; }
    if (!A.configured() || !A.signedIn()) { showGate(); return; }
    start();
  })();
})();
