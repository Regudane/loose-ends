/*
  The Work hub tab (24 Nov 2026). Shows this block's Work hub jobs the way the laptop works them out, and starts
  a job's script on the laptop when Charlie presses Run.

  How a run gets to the laptop: this phone writes a request to OneDrive\Apps\Phone runner\requests, signed with
  a key made on this phone when it was paired (the private half never leaves the phone). Phone runner on the
  laptop checks the signature and that the job is exactly what this phone showed, then starts it in its own
  window, the same as Work hub's own button. A live job needs a yes here first. A request the laptop hasn't
  picked up within 10 minutes is missed and never runs later. The outcome comes back in status\<request>.json.

  Ticks go to Work hub's inbox as a note, the way every Claude chat ticks a job. Work hub files them the next
  time it's open on the laptop; until then this phone shows the tick as its own.
*/
(function () {
  "use strict";
  const L = window.LE, G = window.LEGraph;
  const { $, esc, icon, fmtDate, fmtTime, when } = L;
  const RUN = "Apps/Phone runner";
  const FRESH_MIN = 10;
  const ON_MIN = 9;            // seen.json every 2 minutes, and OneDrive can take a few minutes to pass it on
  const WHO = { script: "Script", claude: "Claude", you: "You", college: "College" };
  const REPEAT = { weekly: "Weekly", fortnightly: "Fortnightly", daily: "Daily", "as-needed": "As needed", quarterly: "Quarterly", yearly: "Yearly" };
  const STAGE_NAME = { A: "Next block's units", B: "Week before", C: "Teaching weeks", D: "Final week", E: "After the block", H: "Holiday block" };
  const enc = new TextEncoder();

  const S = {
    pair: L.lsGet("hub.pair", null), snap: L.lsGet("hub.snap", null), snapTag: L.lsGet("hub.snapTag", ""), seen: L.lsGet("hub.seen", null),
    computers: null, runs: L.lsGet("hub.runs", []), ticks: L.lsGet("hub.ticks", []), view: L.lsGet("hub.view", "block"),
    open: null, pairing: L.lsGet("hub.pairing", null), loading: false, problem: null, readAt: 0, links: {}, expanded: L.lsGet("hub.expanded", {}),
  };
  const saveRuns = () => L.lsSet("hub.runs", S.runs.slice(0, 40));
  const saveTicks = () => L.lsSet("hub.ticks", S.ticks);
  const savePairing = () => L.lsSet("hub.pairing", S.pairing && (S.pairing.state === "waiting" || S.pairing.state === "sending") && S.pairing.id
    ? { id: S.pairing.id, code: S.pairing.code, at: S.pairing.at, state: "waiting" } : null);

  /* ---------- signing, the same text Phone runner checks (core.js signedText) ---------- */
  const b64url = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const signedText = (q) => JSON.stringify(["phone-run/v1", q.id, q.at, q.phone, q.computer, q.where, q.item, q.index, q.block, q.expect, !!q.confirmed]);
  async function pairCode(pub) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("phone-pair/v1|" + pub.x + "|" + pub.y)));
    const n = h[0] * 16777216 + h[1] * 65536 + h[2] * 256 + h[3];
    const s = String(n % 1000000).padStart(6, "0");
    return s.slice(0, 3) + " " + s.slice(3);
  }
  async function sign(key, text) { return b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, enc.encode(text))); }
  const phoneName = () => /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : "Phone";

  /* ---------- reading what the laptop wrote ---------- */
  const mine = () => (S.pair && S.pair.computer) || (S.computers && S.computers[0] && S.computers[0].name) || null;
  async function findComputers() {
    const list = await G.list(RUN + "/computers").catch((e) => (e.code === "missing" ? [] : Promise.reject(e)));
    const found = await Promise.all(list.filter((x) => x.folder).map((x) => G.readJson(RUN + "/computers/" + x.name + "/seen.json").then((r) => ({ name: x.name, seen: r && r.data }), () => ({ name: x.name, seen: null }))));
    return found.sort((a, b) => String((b.seen || {}).seen_at || "").localeCompare(String((a.seen || {}).seen_at || "")));
  }
  async function load() {
    if (S.loading) return;
    S.loading = true; renderTop();
    try {
      if (!S.pair) { S.computers = await findComputers(); await resumePairing(); }
      const pc = mine();
      if (pc) {
        const [seen, it] = await Promise.all([
          G.readJson(RUN + "/computers/" + pc + "/seen.json").catch(() => null),
          G.item(RUN + "/computers/" + pc + "/snapshot.json"),
        ]);
        S.seen = seen ? seen.data : null;
        if (it && it.eTag !== S.snapTag) { S.snap = G.parse(await G.text(it)); S.snapTag = it.eTag; }
        if (!it) { S.snap = null; S.snapTag = ""; }
        L.lsSet("hub.snap", S.snap); L.lsSet("hub.snapTag", S.snapTag); L.lsSet("hub.seen", S.seen);
      } else { S.snap = null; S.seen = null; }
      S.readAt = Date.now(); S.problem = null;
      pruneTicks();
      await pollRuns();
    } catch (e) {
      if (e && e.code === "signin") { S.loading = false; window.dispatchEvent(new CustomEvent("le:signin")); return; }
      S.problem = L.problemFor(e);
    } finally { S.loading = false; render(); schedule(); }
  }

  /* ---------- runs ---------- */
  async function pollRuns() {
    const now = Date.now();
    const look = S.runs.filter((r) => r.state === "waiting" || (r.state === "missed" && r.localMissed && now - Date.parse(r.at) < 40 * 60000));
    await Promise.all(look.map(async (r) => {
      const st = await G.readJson(RUN + "/status/" + r.id + ".json").catch(() => null);
      if (st && st.data && st.data.state) { r.state = st.data.state; r.message = st.data.message || ""; r.localMissed = false; r.answeredAt = st.data.at; }
      else if (r.state === "waiting" && now - Date.parse(r.at) > (FRESH_MIN + 1) * 60000) {
        r.state = "missed"; r.localMissed = true;
        r.message = "The laptop didn't pick it up within " + FRESH_MIN + " minutes, so it won't run. It's probably asleep or off.";
      }
    }));
    saveRuns();
  }
  let pollTimer = null;
  function schedule() {
    clearTimeout(pollTimer);
    const busy = S.runs.some((r) => r.state === "waiting" || r.state === "sending") || (S.pairing && S.pairing.state === "waiting");
    pollTimer = setTimeout(async () => {
      if (document.hidden || !window.LEApp || window.LEApp.tab() !== "hub") { schedule(); return; }
      if (S.pairing && S.pairing.state === "waiting") await checkPairing();
      if (S.runs.some((r) => r.state === "waiting")) { await pollRuns().catch(() => {}); render(); }
      if (Date.now() - S.readAt > 60000) await load(); else schedule();
    }, busy ? 5000 : 30000);
  }

  async function run(where, item, btn) {
    if (!S.pair) { L.toast("Pair this phone with your laptop first. It's at the top of Work hub."); return; }
    if (!S.snap) return;
    const key = await L.idbGet("phone-key").catch(() => null);
    if (!key || key.id !== S.pair.phone) { L.toast("This phone's pairing key is gone, so the laptop won't trust it. Pair again from More.", null, true); return; }
    const pc = S.pair.computer;
    if (btn.live) {
      const ok = await L.ask("Start " + btn.label + " on " + pc + "?", "It writes to " + (btn.liveWhat || "a live system") + ". It opens in its own window on the laptop, the same as pressing it in Work hub.", "Start it");
      if (!ok) return;
    }
    const at = L.nowIso();
    const q = { v: 1, id: "r" + Date.now().toString(36) + "-" + L.rand(8), at, phone: S.pair.phone, computer: pc, where, item: item.id, index: btn.index,
      block: S.snap.block.name, expect: btn.describe, confirmed: !!btn.live, label: btn.label, title: item.title };
    q.sig = await sign(key, signedText(q));
    const r = { id: q.id, at, title: item.title, label: btn.label, computer: pc, state: "sending", live: !!btn.live, where, item: item.id, index: btn.index };
    S.runs.unshift(r); saveRuns(); render();
    try {
      await G.putJson(RUN + "/requests/" + L.stamp(at) + "-" + q.id + ".json", q, { create: true });
      r.state = "waiting";
      const on = laptopOn();
      L.toast(on ? "Sent. It starts on " + pc + " in a minute or two, and its answer shows here a few minutes later." : "Sent, but " + pc + " looks asleep. It runs only if the laptop picks it up within " + FRESH_MIN + " minutes.");
    } catch (e) {
      r.state = "notsent"; r.message = "Not sent. " + L.problemFor(e);
      if (e && e.code === "signin") window.dispatchEvent(new CustomEvent("le:signin"));
    }
    saveRuns(); render(); schedule();
  }

  /* ---------- pairing ---------- */
  async function startPairing() {
    if (S.pairing && S.pairing.state === "waiting") return;
    try {
      const id = "ph-" + L.rand(12);
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
      const pub = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
      const at = L.nowIso();
      await L.idbSet("phone-key-pending", { id, privateKey: kp.privateKey, publicJwk: pub, created: at });
      S.pairing = { id, code: await pairCode(pub), at, state: "sending" };
      savePairing(); render();
      await G.putJson(RUN + "/pairing/" + id + ".json", { id, name: phoneName(), at, public_jwk: pub }, { create: true });
      S.pairing.state = "waiting"; savePairing();
    } catch (e) {
      S.pairing = { state: "error", message: e && e.name === "NotSupportedError" ? "This phone can't make the pairing key." : L.problemFor(e) };
      savePairing();
    }
    render(); schedule();
  }
  /* A pairing this phone started, perhaps before the app was closed: carry on with it. */
  async function resumePairing() {
    if (S.pair) return;
    if (!S.pairing || !S.pairing.id) {
      const k = await L.idbGet("phone-key-pending").catch(() => null);
      if (k && k.id && k.publicJwk && Date.now() - Date.parse(k.created) < 86400000) {
        S.pairing = { id: k.id, code: await pairCode(k.publicJwk), at: k.created, state: "waiting" };
      }
    }
    if (S.pairing && S.pairing.state === "waiting") await checkPairing();
  }
  async function checkPairing() {
    const p = S.pairing;
    if (!p || p.state !== "waiting") return;
    const reply = await G.readJson(RUN + "/pairing/" + p.id + ".reply.json").catch(() => null);
    if (reply && reply.data && reply.data.id === p.id) {
      if (reply.data.accepted) {
        const k = await L.idbGet("phone-key-pending");
        if (!k || k.id !== p.id) { S.pairing = { state: "error", message: "This phone lost its half of the pairing. Start again." }; render(); return; }
        await L.idbSet("phone-key", k); await L.idbSet("phone-key-pending", null);
        S.pair = { phone: p.id, computer: String(reply.data.computer || ""), at: reply.data.at };
        L.lsSet("hub.pair", S.pair);
        S.pairing = null; savePairing(); S.snapTag = "";
        L.toast("Paired with " + S.pair.computer + ". Jobs you press here start there.");
        load();
        return;
      }
      await L.idbSet("phone-key-pending", null).catch(() => {});
      S.pairing = { state: "refused", message: "The laptop said Not mine, so nothing was paired." };
    } else if (Date.now() - Date.parse(p.at) > 15 * 60000) {
      await L.idbSet("phone-key-pending", null).catch(() => {});
      S.pairing = { state: "error", message: "No answer from the laptop after 15 minutes. Open Pair my phone on it, then start again here." };
    }
    savePairing(); render();
  }
  async function unpair() {
    await L.idbSet("phone-key", null).catch(() => {});
    S.pair = null; L.lsSet("hub.pair", null); S.pairing = null; savePairing(); S.snap = null; S.snapTag = ""; L.lsSet("hub.snap", null); L.lsSet("hub.snapTag", "");
    S.computers = null; render(); load();
  }

  /* ---------- ticks, as notes in Work hub's inbox ---------- */
  function findItem(id) {
    if (!S.snap) return null;
    return S.snap.steps.find((x) => x.id === id) || ((S.snap.holiday && S.snap.holiday.steps) || []).find((x) => x.id === id) || null;
  }
  function tickFile(item) { return item.stage === "A" ? S.snap.units.block : item.stage === "H" ? S.snap.holiday && S.snap.holiday.name : S.snap.block.name; }
  function laptopState(item) {
    const st = item.stage === "A" ? S.snap.units.state : item.stage === "H" ? S.snap.holiday && S.snap.holiday.state : S.snap.state;
    return ((st && st.steps) || {})[item.id] || {};
  }
  /* Work hub's own tick rule (inbox.js applyTick). */
  function applyTick(s, rep, t) {
    if ((rep || "once") === "once") {
      if (t.done) { if (!(s.done && s.doneAt)) s.doneAt = t.date; s.done = true; } else { s.done = false; delete s.doneAt; }
    } else {
      const ds = (Array.isArray(s.dates) ? s.dates : []).filter((x) => x !== t.date);
      if (t.done) ds.push(t.date);
      ds.sort(); s.dates = ds.slice(-60);
    }
  }
  function tickState(item) {
    const s = L.clone(laptopState(item));
    const file = tickFile(item);
    S.ticks.filter((t) => t.job === item.id && t.block === file).forEach((t) => applyTick(s, item.repeat, t));
    return s;
  }
  const pendingTick = (item) => S.ticks.some((t) => t.job === item.id && t.block === tickFile(item));
  /* Drop the ticks Work hub has filed (the laptop's snapshot shows them), and any more than a week old. */
  function pruneTicks() {
    if (!S.snap) return;
    S.ticks = S.ticks.filter((t) => {
      if (Date.now() - Date.parse(t.at) > 7 * 864e5) return false;
      const item = findItem(t.job);
      if (!item || tickFile(item) !== t.block) return true;
      const s = laptopState(item);
      const filed = (item.repeat || "once") === "once" ? !!s.done === !!t.done : (s.dates || []).includes(t.date) === !!t.done;
      return !(filed && Date.parse(S.snap.generated_at) >= Date.parse(t.at));
    });
    saveTicks();
  }
  async function tick(item, done) {
    if (!S.snap || !S.snap.hub) { L.toast("Work hub isn't in your OneDrive, so ticks can't go from here.", null, true); return; }
    const at = L.nowIso(), date = L.today(), block = tickFile(item);
    const rep = item.repeat || "once";
    const t = { job: item.id, block, done, date, at };
    const before = S.ticks.slice();
    S.ticks = S.ticks.filter((x) => !(x.job === item.id && x.block === block && (rep === "once" || x.date === date)));
    S.ticks.push(t); saveTicks(); render();
    const note = { from: "Loose Ends app on Charlie's phone", written_at: at, ticks: [{ job: item.id, done, date, block }] };
    try {
      await G.putJson(S.snap.hub + "/inbox/" + L.stamp(at) + "-" + item.id + "-" + L.rand(4) + ".json", note, { create: true });
      L.toast(done ? "Ticked. Work hub files it next time it's open." : "Unticked. Work hub files it next time it's open.");
    } catch (e) {
      S.ticks = before; saveTicks(); render();
      if (e && e.code === "signin") window.dispatchEvent(new CustomEvent("le:signin"));
      L.toast("Not ticked. " + L.problemFor(e), null, true);
    }
  }

  /* ---------- what's due, roughly the way Work hub shows it ---------- */
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function weekStart() { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return L.isoDay(d); }
  function dueWeeks(item) {
    const dw = item.due_weeks;
    if (!dw) return null;
    if (Array.isArray(dw)) return dw;
    return dw[String(S.snap.block.blockNo)] || [];
  }
  function lastDueDay(days) {
    for (let i = 0; i < 7; i++) { const d = new Date(); d.setDate(d.getDate() - i); if (days.includes(d.getDay())) return L.isoDay(d); }
    return L.today();
  }
  /* { done, due, text } for a job's row. */
  function status(item) {
    const rep = item.repeat || "once";
    const s = tickState(item);
    const wk = S.snap.block.week, here = item.stage === S.snap.block.stage || item.stage === "A" || item.stage === "H";
    const dw = dueWeeks(item);
    const td = L.today();
    if (rep === "once") {
      if (s.done) return { done: true, text: "Done" + (s.doneAt ? " " + fmtDate(s.doneAt) : "") };
      if (dw) return dw.includes(wk) && here ? { due: true, text: "Due this week" } : { text: "Weeks " + dw.join(" and ") };
      return { text: "" };
    }
    const dates = Array.isArray(s.dates) ? s.dates : [];
    const last = dates[dates.length - 1];
    if (rep === "daily") {
      if (dates.includes(td)) return { done: true, text: "Done today" };
      const wd = new Date().getDay() >= 1 && new Date().getDay() <= 5;
      return here && wd ? { due: true, text: "Due today" } : { text: last ? "Last done " + fmtDate(last) : "" };
    }
    if (rep === "twice-weekly" && Array.isArray(item.due_days) && item.due_days.length) {
      const d0 = lastDueDay(item.due_days);
      if (dates.some((x) => x >= d0)) return { done: true, text: d0 === td ? "Done today" : "Done since " + dayName[L.parseDate(d0).getDay()] };
      if (!here) return { text: last ? "Last done " + fmtDate(last) : "" };
      return { due: true, text: d0 === td ? "Due today" : "Due since " + dayName[L.parseDate(d0).getDay()] };
    }
    if (rep === "weekly" || rep === "fortnightly") {
      if (dates.some((x) => x >= weekStart())) return { done: true, text: "Done this week" };
      const dueNow = here && (dw ? dw.includes(wk) : rep === "weekly" && S.snap.block.stage === item.stage);
      return dueNow ? { due: true, text: "Due this week" } : { text: dw ? "Weeks " + dw.join(" and ") : last ? "Last done " + fmtDate(last) : "" };
    }
    return { text: last ? "Last done " + fmtDate(last) : "" };
  }
  function repeatText(item) {
    const rep = item.repeat || "once";
    if (rep === "twice-weekly" && Array.isArray(item.due_days)) return item.due_days.map((d) => dayName[d]).join(" and ");
    return REPEAT[rep] || "";
  }

  /* ---------- the laptop ---------- */
  function laptopOn() { const m = S.seen && L.minsAgo(S.seen.seen_at); return m != null && m <= ON_MIN; }
  function lampHTML() {
    const pc = mine();
    if (!pc) return '<span class="l off"></span>No laptop yet';
    if (S.seen && S.seen.problem) return '<span class="l bad"></span>' + esc(pc) + ": " + esc(S.seen.problem);
    if (!S.seen) return '<span class="l off"></span>' + esc(pc) + " hasn't said hello yet";
    return laptopOn() ? '<span class="l on"></span>' + esc(pc) + " is on. Seen " + esc(L.sinceShort(S.seen.seen_at)) + "."
      : '<span class="l off"></span>' + esc(pc) + " looks asleep or off. Last seen " + esc(L.sinceShort(S.seen.seen_at)) + ".";
  }

  /* ---------- drawing ---------- */
  function renderTop() {
    $("h-refresh").classList.toggle("spin", S.loading);
    const sn = S.snap;
    if (!sn || !sn.ok) {
      $("h-block").textContent = "Work hub";
      $("h-when").textContent = sn && sn.message ? sn.message : S.loading ? "Reading it from OneDrive" : "";
      $("h-lamp").innerHTML = lampHTML();
      $("h-line").innerHTML = "";
      return;
    }
    const b = sn.block;
    $("h-block").textContent = b.name;
    const stageLine = { before: "Before the block starts", B: "Week before: intake " + b.intake, C: "Teaching week " + b.week + " of " + b.weeks, D: "Final week", E: "After the block" }[b.stage] || "";
    $("h-when").textContent = stageLine + " · " + L.dayDate(L.today());
    $("h-lamp").innerHTML = lampHTML();
    const order = ["B", "C", "D", "E"], at = order.indexOf(b.stage);
    $("h-line").innerHTML = '<ol class="stops">' + order.map((id, i) =>
      '<li class="stop' + (i < at ? " past" : i === at ? " now" : "") + '"><span class="dot"></span><b>' + id + "</b><small>" +
      esc(id === "C" && b.stage === "C" ? "Week " + b.week + " of " + b.weeks : STAGE_NAME[id]) + "</small></li>").join("") + "</ol>" +
      '<p class="branch"><b>A</b>' + esc("Next block's units: " + b.nextBlock) + "</p>";
  }
  function renderSeg() {
    const sn = S.snap && S.snap.ok ? S.snap : null;
    const waiting = S.runs.filter((r) => r.state === "waiting" || r.state === "sending").length;
    const views = [["block", "This block"]];
    if (sn && sn.holiday) views.push(["holiday", "Holiday"]);
    views.push(["toolbox", "Toolbox"], ["runs", "Runs" + (waiting ? " · " + waiting : "")]);
    if (!views.some((v) => v[0] === S.view)) S.view = "block";
    $("h-seg").innerHTML = views.map((v) => '<button type="button" data-hview="' + v[0] + '" aria-current="' + (S.view === v[0]) + '">' + esc(v[1]) + "</button>").join("");
  }
  function pairCard() {
    const p = S.pairing;
    if (S.pair) return "";
    const found = S.computers && S.computers.length ? S.computers[0].name : null;
    if (p && (p.state === "waiting" || p.state === "sending")) {
      return '<section class="pair"><p class="plate">Pairing</p><h2>Check the laptop shows</h2><p class="code">' + esc(p.code) + "</p>" +
        "<p>On the laptop, the Pair my phone window shows six digits within a minute or two. If they match these, press <b>That's my phone</b> there. Its answer comes back through OneDrive, which can take a few minutes, and this page keeps checking.</p>" +
        '<p class="wait"><span class="l on pulse"></span>' + (p.state === "sending" ? "Sending to OneDrive" : "Waiting for the laptop") + '</p><button type="button" class="hbtn ghost" data-hpair="cancel">Cancel</button></section>';
    }
    if (S.computers && !found) {
      return '<section class="pair"><p class="plate">Set up</p><h2>Phone runner isn\'t on your laptop yet</h2>' +
        "<p>At the laptop, open OneDrive, Apps, Phone runner and double-click <b>Install Phone runner</b>. Then come back here to pair.</p>" +
        '<button type="button" class="hbtn" data-hreload>Check again</button></section>';
    }
    return '<section class="pair"><p class="plate">One-time set-up</p><h2>Pair this phone with ' + esc(found || "your laptop") + "</h2>" +
      (p && p.message ? '<p class="err">' + esc(p.message) + "</p>" : "") +
      '<ol><li>On the laptop, double-click <b>Pair my phone</b> (OneDrive, Apps, Phone runner).</li><li>Tap <b>Start pairing</b> below.</li><li>If both screens show the same six digits, press <b>That\'s my phone</b> on the laptop.</li></ol>' +
      '<button type="button" class="hbtn" data-hpair="start">Start pairing</button></section>';
  }
  function rowHTML(item, where) {
    const st = where === "toolbox" || where === "reminder" ? null : status(item);
    const runs = (item.buttons || []).filter((b) => b.run);
    const quick = runs.length === 1 && (item.buttons || []).filter((b) => b.kind === "bat" || b.kind === "py").length === 1 ? runs[0] : null;
    const plates = [WHO[item.who] || "", repeatText(item)].filter(Boolean).map((x) => '<span class="pl">' + esc(x) + "</span>").join("");
    const tickBtn = st ? '<button type="button" class="tick' + (st.done ? " on" : "") + (pendingTick(item) ? " pend" : "") + '" data-htick="' + esc(item.id) + '" aria-pressed="' + !!st.done + '" aria-label="' + (st.done ? "Untick " : "Tick ") + esc(item.title) + '">' + icon("check") + "</button>" : '<span class="tick none"></span>';
    return '<li class="job' + (st && st.due ? " due" : "") + (st && st.done ? " done" : "") + '">' + tickBtn +
      '<button type="button" class="job-b" data-hopen="' + esc(where + "|" + item.id) + '"><span class="jt">' + esc(item.title) + '</span><span class="jm">' + plates +
      (st && st.text ? '<span class="dw' + (st.due ? " hot" : "") + '">' + esc(st.text) + "</span>" : "") + "</span></button>" +
      (quick ? '<button type="button" class="go' + (quick.live ? " live" : "") + '" data-hrun="' + esc(where + "|" + item.id + "|" + quick.index) + '" aria-label="Run ' + esc(quick.label) + ' on the laptop"' + (S.pair ? "" : " disabled") + ">" + icon("play") + "</button>" : "") +
      "</li>";
  }
  function blockView() {
    const sn = S.snap, b = sn.block;
    let h = "";
    if (sn.carryOver) h += '<p class="carry"><b>Still open from ' + esc(sn.carryOver.block) + ":</b> " + esc(sn.carryOver.titles.join(", ")) + "</p>";
    if (sn.stateProblem) h += '<p class="carry bad">' + esc(sn.stateProblem) + "</p>";
    const stages = {}; (sn.stages || []).forEach((s) => { stages[s.id] = s; });
    const cur = ["B", "C", "D", "E"].includes(b.stage) ? b.stage : "B";
    const order = [cur, "A"].concat(["B", "C", "D", "E"].filter((x) => x !== cur));
    const after = ["B", "C", "D", "E"].indexOf(cur);
    order.forEach((id) => {
      const items = sn.steps.filter((x) => x.stage === id);
      if (!items.length) return;
      const st = stages[id] || { title: STAGE_NAME[id], sub: "" };
      const kicker = id === cur ? "Now" : id === "A" ? "All block" : ["B", "C", "D", "E"].indexOf(id) < after ? "Earlier" : "Coming up";
      const open = S.expanded[id] != null ? S.expanded[id] : (id === cur || id === "A");
      const left = items.filter((x) => !status(x).done).length;
      h += '<section class="stage' + (id === cur ? " now" : "") + '"><button type="button" class="st-h" data-hexp="' + id + '" aria-expanded="' + open + '"><span class="st-k">' + esc(kicker) + '</span><span class="st-t"><b>' + id + "</b>" + esc(st.title) + '</span><span class="st-n">' + (left ? left + " to do" : "All done") + "</span>" + icon("chev") + "</button>" +
        (open ? (st.sub ? '<p class="st-sub">' + esc(st.sub) + "</p>" : "") + '<ul class="jobs">' + items.map((x) => rowHTML(x, "steps")).join("") + "</ul>" : "") + "</section>";
    });
    if (sn.reminders && sn.reminders.length) {
      h += '<section class="stage"><div class="st-h flat"><span class="st-k">This month</span><span class="st-t">Reminders</span></div><ul class="jobs">' + sn.reminders.map((x) => rowHTML(x, "reminder")).join("") + "</ul></section>";
    }
    return h;
  }
  function holidayView() {
    const ho = S.snap.holiday;
    const when2 = ho.status === "ahead" ? "Starts " + L.dayDate(ho.from) : ho.status === "now" ? "On now" + (ho.to ? ", until " + L.dayDate(ho.to) : "") : "Finished";
    let h = '<section class="hol"><p class="plate">' + esc(when2) + "</p><h2>" + esc(ho.title) + "</h2>" + (ho.sub ? "<p>" + esc(ho.sub) + "</p>" : "") + "</section>";
    if (ho.problem) h += '<p class="carry bad">' + esc(ho.problem) + "</p>";
    const groups = (ho.groups || []).slice();
    ho.steps.forEach((s) => { const g = s.group || "Any time"; if (!groups.includes(g)) groups.push(g); });
    groups.forEach((g) => {
      const items = ho.steps.filter((s) => (s.group || "Any time") === g);
      if (!items.length) return;
      const info = (ho.groupInfo || {})[g];
      h += '<section class="stage"><div class="st-h flat"><span class="st-t">' + esc(g) + "</span></div>" + (info ? '<p class="st-sub">' + esc(info) + "</p>" : "") + '<ul class="jobs">' + items.map((x) => rowHTML(x, "steps")).join("") + "</ul></section>";
    });
    if (ho.reminders && ho.reminders.length) h += '<section class="stage"><div class="st-h flat"><span class="st-k">In the break</span><span class="st-t">Reminders</span></div><ul class="jobs">' + ho.reminders.map((x) => rowHTML(x, "reminder")).join("") + "</ul></section>";
    return h;
  }
  function toolboxView() {
    return S.snap.toolbox.map((g) => '<section class="stage"><div class="st-h flat"><span class="st-t">' + esc(g.title) + '</span></div><ul class="jobs">' + g.tools.map((t) => rowHTML(t, "toolbox")).join("") + "</ul></section>").join("");
  }
  const RUN_STATE = { sending: "Sending", waiting: "Waiting for the laptop", started: "Started", missed: "Missed", refused: "Didn't start", notsent: "Not sent" };
  function runsView() {
    if (!S.runs.length) return '<div class="h-empty"><b>Nothing run from here yet</b>Jobs you start from this phone show here, with what the laptop said.</div>';
    const waiting = S.runs.some((r) => r.state === "waiting");
    return (waiting ? '<p class="h-note">The laptop starts a job a minute or two after you press it. Its answer comes back through OneDrive and can take a few more minutes to show here.</p>' : "") + '<ul class="runs">' + S.runs.map((r) => '<li class="run ' + esc(r.state) + '"><span class="l ' + ({ started: "on", waiting: "on pulse", sending: "on pulse", missed: "bad", refused: "bad", notsent: "bad" }[r.state] || "off") + '"></span><div><p class="rt">' + esc(r.title) +
      (r.label && r.label !== r.title ? ' <span class="rl">' + esc(r.label) + "</span>" : "") + '</p><p class="rs"><b>' + esc(RUN_STATE[r.state] || r.state) + "</b> · " + esc(when(r.at)) + " on " + esc(r.computer) + "</p>" +
      (r.message && r.state !== "started" ? '<p class="rm">' + esc(r.message) + "</p>" : "") + "</div></li>").join("") + "</ul>";
  }
  function renderMain() {
    let h = pairCard();
    if (S.problem) h += '<p class="carry bad">' + esc(S.problem) + ' <button type="button" class="link" data-hreload>Try again</button></p>';
    const sn = S.snap;
    if (!sn) {
      if (!h) h += S.loading ? '<div class="h-empty"><b>Reading Work hub</b>From the laptop, through OneDrive.</div>' : '<div class="h-empty"><b>Nothing from the laptop yet</b>Phone runner writes this block\'s jobs here once it\'s running on the laptop.</div>';
    } else if (!sn.ok) {
      h += '<div class="h-empty"><b>Work hub couldn\'t be read on the laptop</b>' + esc(sn.message || "") + "</div>";
    } else {
      if (S.view === "holiday" && sn.holiday) h += holidayView();
      else if (S.view === "toolbox") h += toolboxView();
      else if (S.view === "runs") h += runsView();
      else h += blockView();
      h += '<p class="h-foot">From ' + esc(sn.computer) + ", worked out " + esc(when(sn.generated_at)) + ". " + (S.pair ? "Run starts the job on the laptop, in its own window." : "Pair this phone to start jobs from here.") + "</p>";
    }
    $("h-main").innerHTML = h;
  }

  /* ---------- one job, on its own panel ---------- */
  function itemFor(key) {
    if (!S.snap || !key) return null;
    const [where, id] = key.split("|");
    if (where === "toolbox") { for (const g of S.snap.toolbox) { const t = g.tools.find((x) => x.id === id); if (t) return { key: where, where, item: t }; } return null; }
    const list = where === "reminder" ? S.snap.reminders.concat((S.snap.holiday && S.snap.holiday.reminders) || []) : S.snap.steps.concat((S.snap.holiday && S.snap.holiday.steps) || []);
    const item = list.find((x) => x.id === id);
    return item ? { key: where, where: where === "reminder" ? "steps" : where, item, reminder: where === "reminder" } : null;
  }
  /* Only plain https pages, whatever a file in OneDrive says. */
  function safeUrl(u, must) {
    try { const x = new URL(String(u || "")); return x.protocol === "https:" && !x.username && !x.password && (!must || must.test(x.href)); } catch (e) { return false; }
  }
  function lastRun(item, btn) { return S.runs.find((r) => r.item === item.id && r.index === btn.index) || null; }
  function btnHTML(found, btn) {
    const item = found.item;
    const kindIcon = { bat: "play", py: "play", chat: "chat", claude: "spark", folder: "folder", classfolder: "folder", file: "file", link: "link" }[btn.kind] || "open";
    if (btn.kind === "bat" || btn.kind === "py") {
      const lr = lastRun(item, btn);
      const can = btn.run && S.pair;
      return '<div class="lever' + (btn.live ? " live" : "") + '"><button type="button" class="lv-b" data-hrun="' + esc(found.key + "|" + item.id + "|" + btn.index) + '"' + (can ? "" : " disabled") + ">" + icon("play") +
        "<span><b>" + esc(btn.label) + "</b><small>" + (btn.run ? (S.pair ? "Run on " + esc(S.pair.computer) : "Pair this phone to run it") : "Not on the laptop") + "</small></span>" + (btn.live ? '<i class="live-pl">Live</i>' : "") + "</button>" +
        '<p class="desc">' + esc(btn.describe) + "</p>" + (btn.live ? '<p class="lw">Writes to ' + esc(btn.liveWhat) + "</p>" : "") +
        (lr ? '<p class="lr ' + esc(lr.state) + '">' + esc(RUN_STATE[lr.state] || lr.state) + " " + esc(when(lr.at)) + (lr.message && lr.state !== "started" ? ": " + esc(lr.message) : "") + "</p>" : "") + "</div>";
    }
    let href = "", note = "";
    if (btn.kind === "chat" && safeUrl(btn.url, /^https:\/\/claude\.ai\//)) { href = btn.url; note = btn.prompt ? "Copies the job's prompt, then opens its chat" : "Opens its chat in Claude"; }
    else if (btn.kind === "claude" && btn.prompt) {
      const text = (S.snap.prompts || {})[btn.prompt] || "";
      href = "https://claude.ai/new" + (text && text.length <= 6000 ? "?q=" + encodeURIComponent(text) : "");
      note = "Copies the job's prompt, then opens a new chat";
    } else if (btn.kind === "link" && safeUrl(btn.url)) { href = btn.url; note = new URL(btn.url).hostname; }
    else if (btn.onedrive) {
      const u = S.links[btn.onedrive];
      if (u && safeUrl(u)) { href = u; note = "Opens in OneDrive"; } else note = u === "" ? "Couldn't find it in OneDrive" : "Finding it in OneDrive";
    } else note = btn.exists ? "Only on the laptop" : "Not on the laptop";
    const attrs = btn.prompt ? ' data-hprompt="' + esc(btn.prompt) + '" data-hkind="' + esc(btn.kind) + '"' : "";
    return href ? '<a class="pbtn" href="' + esc(href) + '" target="_blank" rel="noopener"' + attrs + ">" + icon(kindIcon) + "<span><b>" + esc(btn.label) + "</b><small>" + esc(note) + "</small></span></a>"
      : '<span class="pbtn off">' + icon(kindIcon) + "<span><b>" + esc(btn.label) + "</b><small>" + esc(note) + "</small></span></span>";
  }
  function renderPanel() {
    const w = $("h-sheet");
    const found = S.open && itemFor(S.open);
    if (!found) { w.hidden = true; return; }
    const item = found.item, btns = item.buttons || [];
    const isStep = found.where === "steps" && !found.reminder;
    const st = isStep ? status(item) : null;
    const kick = found.where === "toolbox" ? "Toolbox" : found.reminder ? "Reminder" + (item.when ? ", " + item.when : "") : (item.stage || "") + " · " + (STAGE_NAME[item.stage] || "");
    const plates = [WHO[item.who] || "", repeatText(item)].filter(Boolean).map((x) => '<span class="pl">' + esc(x) + "</span>").join("") + (st && st.text ? '<span class="dw' + (st.due ? " hot" : "") + '">' + esc(st.text) + "</span>" : "");
    const laptop = btns.filter((b) => b.kind === "bat" || b.kind === "py");
    const phone = btns.filter((b) => !(b.kind === "bat" || b.kind === "py"));
    let h = '<p class="plate">' + esc(kick) + '</p><h2 id="h-p-title">' + esc(item.title) + '</h2><p class="jm">' + plates + "</p>" +
      (item.help ? '<p class="help">' + esc(item.help) + "</p>" : "");
    if (laptop.length) h += "<h3>On the laptop</h3>" + laptop.map((b) => btnHTML(found, b)).join("");
    if (phone.length) h += '<h3>On your phone</h3><div class="pbtns">' + phone.map((b) => btnHTML(found, b)).join("") + "</div>";
    if (!btns.length) h += '<p class="help">Nothing to press for this one.</p>';
    $("h-p-body").innerHTML = h;
    let bar = "";
    if (isStep) {
      const rep = item.repeat || "once";
      const s = tickState(item);
      const on = rep === "once" ? !!s.done : (s.dates || []).includes(L.today());
      const label = rep === "once" ? (on ? "Done. Untick it" : "Mark it done") : (on ? "Done today. Untick" : "Done today");
      bar = '<button type="button" class="tickbar' + (on ? " on" : "") + '" data-htick="' + esc(item.id) + '">' + icon("check") + esc(label) + "</button>" +
        (pendingTick(item) ? '<p class="tb-note">Ticked here. Work hub files it next time it\'s open on the laptop.</p>' : "");
    } else if (found.reminder) bar = '<p class="tb-note">Reminders are ticked in Work hub on the laptop.</p>';
    $("h-p-bar").innerHTML = bar;
    $("h-p-bar").hidden = !bar;
    w.hidden = false;
  }
  function openPanel(key) {
    S.open = key;
    const found = itemFor(key);
    if (!found) return;
    renderPanel();
    document.body.classList.add("locked"); L.toastUp(true);
    $("h-p-body").scrollTop = 0;
    (found.item.buttons || []).forEach((b) => {
      if (b.onedrive && !(b.onedrive in S.links)) {
        S.links[b.onedrive] = null;
        G.item(b.onedrive).then((it) => { S.links[b.onedrive] = it && it.webUrl ? it.webUrl : ""; if (S.open) renderPanel(); }, () => { S.links[b.onedrive] = ""; if (S.open) renderPanel(); });
      }
    });
    const c = document.querySelector("#h-sheet .p-close"); if (c) c.focus({ preventScroll: true });
  }
  function closePanel() { S.open = null; $("h-sheet").hidden = true; document.body.classList.remove("locked"); L.toastUp(false); }

  function render() {
    renderTop(); renderSeg(); renderMain();
    if (S.open) renderPanel();
    const waiting = S.runs.filter((r) => r.state === "waiting" || r.state === "sending").length;
    window.dispatchEvent(new CustomEvent("le:hubcount", { detail: { waiting } }));
  }

  /* ---------- events ---------- */
  function onClick(ev) {
    const t = ev.target;
    const v = t.closest("[data-hview]");
    if (v) { S.view = v.getAttribute("data-hview"); L.lsSet("hub.view", S.view); renderSeg(); renderMain(); window.scrollTo({ top: 0 }); return; }
    if (t.closest("[data-hreload]") || t.closest("#h-refresh")) { S.snapTag = ""; load(); return; }
    const ex = t.closest("[data-hexp]");
    if (ex) { const id = ex.getAttribute("data-hexp"); S.expanded[id] = ex.getAttribute("aria-expanded") !== "true"; L.lsSet("hub.expanded", S.expanded); renderMain(); return; }
    const pr = t.closest("[data-hpair]");
    if (pr) {
      if (pr.getAttribute("data-hpair") === "start") startPairing();
      else { S.pairing = null; savePairing(); L.idbSet("phone-key-pending", null).catch(() => {}); render(); }
      return;
    }
    const rn = t.closest("[data-hrun]");
    if (rn) {
      const [where, id, index] = rn.getAttribute("data-hrun").split("|");
      const found = itemFor(where + "|" + id);
      const btn = found && (found.item.buttons || []).find((b) => String(b.index) === index);
      if (found && btn) run(found.where, found.item, btn);
      return;
    }
    const tk = t.closest("[data-htick]");
    if (tk) {
      const item = findItem(tk.getAttribute("data-htick"));
      if (!item) return;
      const rep = item.repeat || "once", s = tickState(item);
      tick(item, rep === "once" ? !s.done : !(s.dates || []).includes(L.today()));
      return;
    }
    const op = t.closest("[data-hopen]");
    if (op) { openPanel(op.getAttribute("data-hopen")); return; }
    if (t.closest("[data-hclose]")) { closePanel(); return; }
    const pp = t.closest("[data-hprompt]");
    if (pp) {
      const text = (S.snap && S.snap.prompts || {})[pp.getAttribute("data-hprompt")] || "";
      if (text) {
        try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) {}
        L.toast(pp.getAttribute("data-hkind") === "chat" ? "The job's prompt is copied: paste it into the chat and send." : "The job's prompt is copied. If Claude didn't type it in, paste it.");
      }
    }
  }

  function init() {
    $("v-hub").addEventListener("click", onClick);
    $("h-sheet").addEventListener("click", onClick);
    if (S.snap) pruneTicks();
    render();
  }
  function shown() { render(); if (!S.readAt || Date.now() - S.readAt > 60000) load(); else schedule(); }
  function escape() { if (!S.open) return false; closePanel(); return true; }
  function info() { return { pair: S.pair, computer: mine() }; }

  window.LEHub = { init, load, shown, render, escape, unpair, info, _state: S, _signedText: signedText, _pairCode: pairCode };
})();
