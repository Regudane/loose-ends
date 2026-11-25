/*
  The Loose Ends tab: the board from OneDrive\Apps\Loose Ends\data, put together exactly the way the desktop
  app puts it together (merge.js is the desktop app's own), with Charlie's Done, Snooze, Pin, Whose move and
  notes for Claude saved only to data\changes-phone.json, in the desktop app's format. Never cards.json, and
  never a note in the inbox (those belong to the chats).

  Replies (1.4.0, 25 Nov 2026): on a card with a chat, what Charlie types is his reply in that chat. It goes to the
  laptop as a signed request (workhub.js sendReply), and Phone runner types it into the chat in the Claude app and
  sends it. When the laptop can't, one tap copies it and opens the chat in the Claude app on this phone.
*/
(function () {
  "use strict";
  const L = window.LE, G = window.LEGraph, M = window.LooseMerge;
  const { $, esc, icon } = L;
  const DATA = "Apps/Loose Ends/data";
  const PHONE = "changes-phone.json";
  const AREAS = [{ id: "magill", name: "Magill" }, { id: "ves", name: "VES" }, { id: "personal", name: "Personal" }, { id: "tech", name: "Tech" }];
  const AREA_NAME = {}; AREAS.forEach((a) => { AREA_NAME[a.id] = a.name; });
  const MOVES = { you: "Your move", claude: "Claude's move", others: "Waiting on others", later: "Later" };
  const MOVE_KEYS = ["you", "claude", "others", "later"];
  const MOVE_ORDER = { you: 0, claude: 1, others: 2, later: 3 };
  const { parseDate, fmtDate, dayDate, fmtTime, daysSince, when, ago, agoLong, today, addDays, nextMonday, nowIso } = L;

  /* ---------- what goes where, the same as the desktop app ---------- */
  const isOpen = (c) => c.status !== "done";
  const isSnoozed = (c) => isOpen(c) && !!c.snooze_until && c.snooze_until > today();
  const isLive = (c) => isOpen(c) && !isSnoozed(c);
  const recentDone = (c) => { const d = parseDate(c.done_at); return c.status === "done" && !!d && (Date.now() - d.getTime()) < 30 * 864e5; };
  const needsLook = (c) => c.unreadable === true || /can.?t (be )?read|not readable/i.test([c.tldr, c.where].join(" "));
  const areaOf = (c) => (AREA_NAME[c.area] ? c.area : "personal");
  const moveOf = (c) => (MOVES[c.move] ? c.move : "later");
  const byRecent = (l) => l.slice().sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || String(b.last_touched || "").localeCompare(String(a.last_touched || "")));
  const byMoveThenRecent = (l) => l.slice().sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((MOVE_ORDER[a.move] ?? 9) - (MOVE_ORDER[b.move] ?? 9)) || String(b.last_touched || "").localeCompare(String(a.last_touched || "")));
  const notesOf = (c) => (Array.isArray(c.charlie_notes) ? c.charlie_notes.filter((n) => n && typeof n.text === "string") : []);
  const isNewNote = (c, n) => { const r = parseDate(c.notes_read_at), a = parseDate(n.at); return !r || !a || a > r; };
  /* A chat or a session in the Claude app: only claude.ai links, rebuilt from their own id. */
  const isChat = (link) => /^https:\/\/claude\.ai\/chat\//.test(String(link || ""));
  /* Replies sent from this phone (1.4.0), kept here only so the card shows them: {card: [{at, text, how}]} */
  const repliesOf = (id) => ((L.lsGet("board.replies", {}) || {})[id] || []);
  function addReply(id, text, how) {
    const all = L.lsGet("board.replies", {}) || {}, cut = Date.now() - 30 * 86400000;
    Object.keys(all).forEach((k) => { all[k] = (all[k] || []).filter((x) => Date.parse(x.at) > cut); if (!all[k].length) delete all[k]; });
    all[id] = (all[id] || []).concat([{ at: nowIso(), text, how }]).slice(-6);
    L.lsSet("board.replies", all);
  }
  function copyText(text) { try { const p = navigator.clipboard && navigator.clipboard.writeText(text); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  const chatLink = (url) => { const m = /^https:\/\/claude\.ai\/(chat\/[0-9a-f-]{36}|code\/session_[A-Za-z0-9_-]{8,80})\/?$/i.exec(String(url || "").trim()); return m ? "https://claude.ai/" + m[1] : null; };

  const S = { base: null, changes: {}, phoneServer: { edits: {}, added: {} }, pending: [], notes: [], cards: [], meta: {},
    view: L.lsGet("board.view", "all"), q: "", open: null, readAt: null, cachedAt: null, problem: null, loading: false, snz: false, reply: null };

  function matches(c) {
    if (!S.q) return true;
    const cu = c.catch_up || {};
    const hay = [c.title, c.next, c.tldr, c.where, (c.context || []).join(" "), AREA_NAME[c.area], MOVES[c.move], cu.left_off, (cu.decided || []).join(" "), (cu.open || []).join(" "), notesOf(c).map((n) => n.text).join(" ")].join(" ").toLowerCase();
    return S.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  const publicLive = () => S.cards.filter((c) => isLive(c) && !c.private);
  function groupByMove(list) {
    const out = [];
    MOVE_KEYS.forEach((k) => { const cs = byRecent(list.filter((c) => !needsLook(c) && moveOf(c) === k)); if (cs.length) out.push({ title: MOVES[k], cards: cs }); });
    const look = byRecent(list.filter(needsLook));
    if (look.length) out.push({ title: "Needs a look", cards: look });
    return out;
  }
  function currentList() {
    if (S.q) {
      const secs = [], open = byMoveThenRecent(S.cards.filter((c) => isLive(c) && matches(c)));
      const snz = S.cards.filter((c) => isSnoozed(c) && matches(c)), done = S.cards.filter((c) => recentDone(c) && matches(c));
      if (open.length) secs.push({ title: "Open", cards: open });
      if (snz.length) secs.push({ title: "Snoozed", cards: snz, mode: "snoozed" });
      if (done.length) secs.push({ title: "Done, last 30 days", cards: done, mode: "done" });
      return { title: "Search", sort: "Best match first", sections: secs, empty: ["Nothing matches", "Try a unit code, a person or a word from the next step."] };
    }
    const v = S.view, live = publicLive();
    if (MOVES[v]) return { title: MOVES[v], sort: "Newest first", sections: [{ cards: byRecent(live.filter((c) => !needsLook(c) && moveOf(c) === v)) }],
      empty: { you: ["Nothing is waiting on you", "New loose ends land here after the morning sweep."], claude: ["Nothing is waiting on Claude", "When Claude owes you something, it shows here."], others: ["Nobody owes you anything", "Things you're waiting on from other people show here."], later: ["Nothing parked", "Things you've put off on purpose show here."] }[v] };
    if (v === "look") return { title: "Needs a look", sort: "Newest first", sections: [{ cards: byRecent(live.filter(needsLook)) }], empty: ["Nothing needs a look", "Chats a sweep can't read (inside a Project or Claude Code) show here."] };
    if (v === "all") return { title: "Everything open", sort: "By whose move", sections: groupByMove(live), empty: ["No loose ends", "Everything is tied off."] };
    if (v.indexOf("area:") === 0) { const a = v.slice(5); return { title: AREA_NAME[a] || a, sort: "By whose move", sections: groupByMove(live.filter((c) => areaOf(c) === a)), empty: ["All clear in " + (AREA_NAME[a] || a), "Nothing open here right now."] }; }
    if (v === "private") {
      const s2 = groupByMove(S.cards.filter((c) => isLive(c) && c.private));
      const ps = S.cards.filter((c) => isSnoozed(c) && c.private), pd = S.cards.filter((c) => recentDone(c) && c.private);
      if (ps.length) s2.push({ title: "Snoozed", cards: ps, mode: "snoozed" });
      if (pd.length) s2.push({ title: "Done, last 30 days", cards: pd, mode: "done" });
      return { title: "Private", sort: "By whose move", sections: s2, empty: ["Nothing private open", "Family, legal and health matters show here, out of sight of the main lists."] };
    }
    if (v === "snoozed") return { title: "Snoozed", sort: "Back soonest first", sections: [{ mode: "snoozed", cards: S.cards.filter((c) => isSnoozed(c) && !c.private).sort((a, b) => a.snooze_until.localeCompare(b.snooze_until)) }], empty: ["Nothing snoozed", "Snooze a loose end to hide it until a date."] };
    if (v === "done") return { title: "Done", sort: "Last 30 days", sections: [{ mode: "done", cards: S.cards.filter((c) => recentDone(c) && !c.private).sort((a, b) => String(b.done_at).localeCompare(String(a.done_at))) }], empty: ["Nothing done in the last 30 days", "Ticked-off loose ends stay here for a month."] };
    S.view = "all"; return currentList();
  }
  const flat = (Lst) => Lst.sections.reduce((a, s) => a.concat(s.cards), []);
  function counts() {
    const live = publicLive(), n = {};
    MOVE_KEYS.forEach((k) => { n[k] = live.filter((c) => !needsLook(c) && moveOf(c) === k).length; });
    n.look = live.filter(needsLook).length; n.all = live.length;
    AREAS.forEach((a) => { n["area:" + a.id] = live.filter((c) => areaOf(c) === a.id).length; });
    n.private = S.cards.filter((c) => isLive(c) && c.private).length;
    n.snoozed = S.cards.filter((c) => isSnoozed(c) && !c.private).length;
    n.done = S.cards.filter((c) => recentDone(c) && !c.private).length;
    return n;
  }
  const cardById = (id) => S.cards.find((c) => c.id === id) || null;

  /* ---------- the board: cards.json, every changes file and the inbox, put together by merge.js ---------- */
  function phoneView() { const p = L.clone(S.phoneServer); S.pending.forEach((j) => j.apply(p)); return p; }
  function recompute() {
    if (!S.base) return;
    const merged = M.mergeBoard(S.base, Object.assign({}, S.changes, { phone: phoneView() }), S.notes);
    S.cards = merged.cards; S.meta = merged.meta || {};
    window.dispatchEvent(new CustomEvent("le:counts", { detail: { you: counts().you } }));
  }
  function remember() { L.lsSet("board", { at: S.readAt, base: S.base, changes: S.changes, phone: S.phoneServer, notes: S.notes }); }

  /* A note never changes once a chat has written it, so each is read from OneDrive only once. */
  const noteCache = L.lsGet("board.notes", {});
  async function readNote(f) {
    const key = f.name + "|" + f.size;
    if (noteCache[key]) return { name: f.name, data: noteCache[key] };
    const data = G.parse(await G.text(f));
    noteCache[key] = data;
    return { name: f.name, data };
  }

  async function load() {
    if (S.loading) return;
    S.loading = true; renderTop();
    try {
      const [files, inbox] = await Promise.all([
        G.list(DATA).catch((e) => Promise.reject(e.code === "missing" ? { code: "missing", message: "Couldn't find Apps\\Loose Ends\\data in your OneDrive." } : e)),
        G.list(DATA + "/inbox").catch((e) => (e.code === "missing" ? [] : Promise.reject(e))),
      ]);
      const cardsFile = files.find((f) => f.file && f.name === "cards.json");
      if (!cardsFile) throw { code: "missing", message: "cards.json isn't in your Loose Ends data folder." };
      const base = G.parse(await G.text(cardsFile));
      if (!base || !Array.isArray(base.cards)) throw { code: "corrupt", message: "cards.json didn't read as a card list." };
      const folded = (base.meta && base.meta.inbox_folded) || {};
      const chFiles = files.filter((f) => f.file && /^changes-(.+)\.json$/i.test(f.name));
      const noteFiles = inbox.filter((f) => f.file && /\.json$/i.test(f.name) && !Object.prototype.hasOwnProperty.call(folded, f.name));
      const [chs, notes] = await Promise.all([
        Promise.all(chFiles.map((f) => G.text(f).then((t) => [/^changes-(.+)\.json$/i.exec(f.name)[1].toLowerCase(), G.parse(t), f.eTag], () => null))),
        Promise.all(noteFiles.map((f) => readNote(f).catch(() => null))),
      ]);
      const changes = {};
      chs.forEach((x) => { if (x && x[1] && typeof x[1] === "object") changes[x[0]] = x[1]; });
      S.phoneServer = changes.phone || { edits: {}, added: {} }; delete changes.phone;
      S.base = base; S.changes = changes; S.notes = notes.filter((n) => n && n.data && typeof n.data === "object" && !Array.isArray(n.data));
      S.readAt = Date.now(); S.cachedAt = null; S.problem = null;
      const keep = {}; noteFiles.forEach((f) => { const k = f.name + "|" + f.size; if (noteCache[k]) keep[k] = noteCache[k]; });
      L.lsSet("board.notes", keep);
      remember();
      recompute();
    } catch (e) {
      if (e && e.code === "signin") { S.loading = false; window.dispatchEvent(new CustomEvent("le:signin")); return; }
      S.problem = L.problemFor(e);
    } finally {
      S.loading = false; render();
    }
  }

  /* ---------- saving: only ever to changes-phone.json, in the desktop app's format ---------- */
  let chain = Promise.resolve();
  function savePhone(apply) {
    const job = { apply };
    S.pending.push(job); recompute(); render();
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const cur = await G.readJson(DATA + "/" + PHONE); // throws "corrupt" rather than write over a file it can't read
        const fresh = cur && cur.data && typeof cur.data === "object" && !Array.isArray(cur.data) ? cur.data : {};
        fresh.edits = fresh.edits || {}; fresh.added = fresh.added || {};
        apply(fresh);
        const body = Object.assign({}, fresh, { computer: "phone", updated_at: nowIso() });
        try {
          await G.putJson(DATA + "/" + PHONE, JSON.stringify(body, null, 2), cur ? { ifMatch: cur.eTag } : { create: true });
          return body;
        } catch (e) {
          if ((e.code === "changed" || e.code === "exists") && attempt < 3) continue; // someone else saved it a moment ago: read it again
          throw e;
        }
      }
    };
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p.then((body) => {
      S.phoneServer = body; S.pending = S.pending.filter((j) => j !== job); recompute(); render(); remember();
      return true;
    }, (e) => {
      S.pending = S.pending.filter((j) => j !== job); recompute(); render();
      if (e && e.code === "signin") window.dispatchEvent(new CustomEvent("le:signin"));
      L.toast("Not saved. " + L.problemFor(e), null, true);
      return false;
    });
  }
  function change(id, fields, undoText, after) {
    const c = cardById(id); if (!c) return;
    const prev = {}; Object.keys(fields).forEach((k) => { prev[k] = c[k] === undefined ? null : c[k]; });
    const at = nowIso();
    if (after) after();
    savePhone((ch) => M.setFields(ch, id, fields, at)).then((ok) => {
      if (ok && undoText) L.toast(undoText, () => change(id, prev, null));
    });
  }
  function noteId(at) { return "n-" + at.replace(/[-:]/g, "").slice(0, 15) + "Z-" + L.rand(4); }

  /* ---------- top, rail and list ---------- */
  function sweepNote() {
    const m = S.meta || {};
    if (m.sweep_problem) return { text: m.sweep_problem, warn: true };
    if (!m.last_sweep) return { text: "Not swept yet", warn: true };
    const hrs = (Date.now() - parseDate(m.last_sweep).getTime()) / 36e5;
    if (m.sweeper_chat_url && hrs > 26) return { text: "Morning sweep missed. Last swept " + when(m.last_sweep) + ".", warn: true };
    return { text: "Swept " + when(m.last_sweep) + ".", warn: daysSince(m.last_sweep) >= 3 };
  }
  function renderTop() {
    $("b-refresh").classList.toggle("spin", S.loading);
    if (!S.base) { $("b-sum").textContent = S.problem ? "Your board couldn't be read" : "Opening your board"; $("b-sync").textContent = S.loading ? "Reading it from OneDrive" : ""; return; }
    const n = counts();
    $("b-sum").innerHTML = n.all + " open. <b>" + n.you + "</b> " + (n.you === 1 ? "is" : "are") + " your move.";
    const sn = sweepNote();
    const read = S.loading ? " Reading it again now." : S.cachedAt ? " Showing what was read " + when(new Date(S.cachedAt).toISOString()) + "." : S.readAt ? " Read " + fmtTime(new Date(S.readAt).toISOString()) + "." : "";
    $("b-sync").textContent = sn.text + read;
    $("b-sync").classList.toggle("warn", sn.warn);
    const b = $("b-banner");
    if (S.problem && S.base) { b.innerHTML = "<span>" + esc(S.problem) + '</span><button type="button" data-breload>Try again</button>'; b.hidden = false; } else b.hidden = true;
  }
  function renderRail() {
    if (!S.base) { $("b-rail").innerHTML = ""; return; }
    const n = counts();
    const chip = (id, label, k, extra) => '<button type="button" class="chip" data-view="' + esc(id) + '" aria-current="' + (!S.q && S.view === id) + '">' + (extra || "") + esc(label) + '<span class="n' + (id === "you" && n.you ? " hot" : "") + '">' + n[k || id] + "</span></button>";
    $("b-rail").innerHTML = chip("all", "Everything") + chip("you", "Your move") + chip("claude", "Claude's move") + chip("others", "Waiting") + chip("later", "Later") + chip("look", "Needs a look") +
      AREAS.map((a) => chip("area:" + a.id, a.name, null, '<span class="sw a-' + a.id + '"></span>')).join("") + chip("private", "Private") + chip("snoozed", "Snoozed") + chip("done", "Done");
  }
  function tagHTML(c, mode) {
    const d = daysSince(c.last_touched), old = !mode && d != null && d > 21;
    const stampEl = mode === "done" ? '<span class="stamp s-done">Done ' + esc(fmtDate(c.done_at)) + "</span>"
      : mode === "snoozed" ? '<span class="stamp s-snz">Back ' + esc(fmtDate(c.snooze_until)) + "</span>"
      : needsLook(c) ? '<span class="stamp s-look">Needs a look</span>' : '<span class="stamp s-' + moveOf(c) + '">' + esc(MOVES[moveOf(c)]) + "</span>";
    const ns = notesOf(c), last = ns[ns.length - 1], fresh = ns.filter((x) => isNewNote(c, x)).length;
    const next = c.next || (needsLook(c) ? "Say “update the board” in that chat" : "");
    return '<article class="tag a-' + areaOf(c) + (c.status === "done" ? " done" : "") + '">' +
      '<svg class="twine" aria-hidden="true"><use href="#twine"/></svg>' +
      '<button type="button" class="tag-b" data-open="' + esc(c.id) + '"><span class="eye" aria-hidden="true"></span>' +
      '<span class="meta"><span>' + esc(AREA_NAME[areaOf(c)]) + "</span>" + (c.pinned ? '<span title="Pinned">' + icon("pin") + "</span>" : "") + (c.private ? '<span title="Private">' + icon("lock") + "</span>" : "") +
      '<span class="age' + (old ? " old" : "") + '">' + esc(ago(c.last_touched)) + "</span>" + stampEl + "</span>" +
      '<span class="t">' + esc(c.title) + "</span>" +
      (c.tldr ? '<span class="tldr">' + esc(c.tldr) + "</span>" : "") +
      (next ? '<span class="nx"><b>Next</b>' + esc(next) + "</span>" : "") +
      (last ? '<span class="cn"><i>' + esc(fmtDate(last.at) || "Note") + (ns.length > 1 ? ", " + ns.length + " notes" : "") + "</i>" + esc(last.text) + (fresh ? '<span class="new">' + (fresh > 1 ? fresh + " new" : "New") + "</span>" : "") + "</span>" : "") +
      "</button></article>";
  }
  function renderList() {
    const el = $("b-list");
    if (!S.base) {
      el.innerHTML = S.problem ? '<div class="empty"><b>Your board couldn\'t be read</b>' + esc(S.problem) + '<br><button type="button" class="btn" data-breload>Try again</button></div>'
        : '<div class="tags">' + [1, 2, 3].map(() => '<article class="tag skel a-tech"><div class="tag-b"><span></span><span></span><span></span><span></span></div></article>').join("") + "</div>";
      return;
    }
    const Lst = currentList(), all = flat(Lst);
    let h = '<h2 class="view-h">' + esc(Lst.title) + '<span class="n">' + all.length + "</span><small>" + esc(Lst.sort) + "</small></h2>";
    if (!all.length) h += '<div class="empty"><b>' + esc(Lst.empty[0]) + "</b>" + esc(Lst.empty[1]) + "</div>";
    Lst.sections.forEach((s) => {
      if (!s.cards.length) return;
      if (s.title && Lst.sections.length > 1) h += '<h3 class="grp">' + esc(s.title) + ' <span class="n">' + s.cards.length + "</span></h3>";
      h += '<div class="tags">' + s.cards.map((c) => tagHTML(c, s.mode)).join("") + "</div>";
    });
    el.innerHTML = h;
  }

  /* ---------- the sheet: one loose end, hung on its string ---------- */
  function jobChats(c) {
    const seen = {}, out = [];
    const add = (url, title, touched, main) => { const link = chatLink(url); if (!link || seen[link]) return; seen[link] = true; out.push({ link, title: title || "Untitled chat", touched: touched || "", main }); };
    const list = (Array.isArray(c.chats) ? c.chats : []).filter((x) => x && typeof x === "object");
    const mine = list.filter((x) => chatLink(x.url) && chatLink(x.url) === chatLink(c.chat_url))[0];
    add(c.chat_url, mine ? mine.title : c.title, mine ? mine.last_touched : c.last_touched, true);
    list.slice().sort((a, b) => String(b.last_touched || "").localeCompare(String(a.last_touched || ""))).forEach((x) => add(x.url, x.title, x.last_touched, false));
    return out;
  }
  function renderSheet() {
    const w = $("b-sheet");
    if (!S.open) { w.hidden = true; return; }
    const c = cardById(S.open);
    if (!c) { closeSheet(); return; }
    w.querySelector(".sheet").className = "sheet a-" + areaOf(c);
    const cu = c.catch_up || {}, dec = cu.decided || [], opn = cu.open || [], k = moveOf(c);
    let h = '<div class="s-meta"><span class="area a-' + areaOf(c) + '"><span class="sw"></span>' + esc(AREA_NAME[areaOf(c)]) + (c.private ? ", private" : "") + "</span><span>Touched " + esc(agoLong(c.last_touched) || "a while ago") + "</span>" +
      (isSnoozed(c) ? "<span>Snoozed until " + esc(dayDate(c.snooze_until)) + "</span>" : "") + (c.status === "done" ? "<span>Done " + esc(fmtDate(c.done_at)) + "</span>" : "") + (c.pinned ? "<span>Pinned</span>" : "") + "</div>" +
      '<h2 id="b-s-title">' + esc(c.title) + "</h2>";
    if (c.next) h += '<div class="box"><div class="lab">Next step</div><p>' + esc(c.next) + "</p></div>";
    if (needsLook(c) && isOpen(c)) h += '<div class="look">A sweep can’t read this chat because it lives inside a Project or Claude Code. Open it and say “update the board” to fill in this card.</div>';
    if (cu.left_off || dec.length || opn.length || c.tldr) {
      h += "<h3>Catch me up</h3>";
      if (cu.left_off) h += '<div class="story">' + String(cu.left_off).split(/\n{2,}/).map((p) => "<p>" + esc(p) + "</p>").join("") + "</div>";
      else if (c.tldr) h += '<div class="story"><p>' + esc(c.tldr) + '</p></div><p class="muted">No full catch-up yet. The morning sweep writes one the next time this chat changes.</p>';
      if (dec.length || opn.length) h += '<div class="cols">' + (dec.length ? "<div><h4>Decided</h4><ul>" + dec.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul></div>" : "") + (opn.length ? "<div><h4>Still open</h4><ul>" + opn.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul></div>" : "") + "</div>";
      if (cu.at) h += '<p class="muted">Caught up ' + esc(when(cu.at)) + ".</p>";
    }
    if (c.status !== "done") h += '<h3>Whose move</h3><div class="moves" role="group" aria-label="Whose move">' + MOVE_KEYS.map((m) => '<button type="button" class="mv s-' + m + '" data-move="' + m + '" aria-pressed="' + (m === k) + '">' + esc(MOVES[m]) + "</button>").join("") + "</div>";
    $("b-s-top").innerHTML = h;

    // 1.4.0: with a chat to reply to, what's typed here is a reply in that chat, not a note on the card
    const rlink = chatLink(c.chat_url) || (jobChats(c)[0] || {}).link;
    $("b-nhead").textContent = rlink ? "Reply to its chat" : "Your notes for Claude";
    $("b-nlabel").textContent = rlink ? "Your reply to this job's chat" : "Note for Claude";
    $("b-ntext").placeholder = rlink ? "Your reply, as if you typed it in the chat" : "Tell Claude something about this job";
    $("b-nhint").textContent = !rlink ? "The next chat on this job reads it. Notes stay on the card."
      : isChat(rlink) ? "Your laptop types it into the chat and sends it, and Claude carries on."
      : "It's copied, and the chat opens in the Claude app for you to paste it and send.";
    $("b-nsave").textContent = rlink ? "Send to the chat" : "Save note";
    $("b-s-replies").innerHTML = repliesOf(c.id).slice().reverse().map((x) => '<li class="sent"><div class="nmeta"><span>' + esc(when(x.at) || "") + '</span><span class="st">' +
      (x.how === "laptop" ? "Sent to the chat by the laptop" : "Copied to send from your phone") + "</span></div><p>" + esc(x.text) + "</p></li>").join("");
    const ns = notesOf(c).slice().reverse();
    $("b-s-nhead").hidden = !(rlink && ns.length);
    $("b-s-notes").innerHTML = ns.map((n) => { const f = isNewNote(c, n); return '<li class="' + (f ? "fresh" : "") + '"><div class="nmeta"><span>' + esc(when(n.at) || "No date") + '</span><span class="st">' + (f ? "New: the next chat on this job reads it" : "Read by Claude") + "</span></div><p>" + esc(n.text) + "</p></li>"; }).join("");
    renderReply();

    let r = "";
    if (c.context && c.context.length) r += "<h3>Details</h3><ul>" + c.context.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>";
    const chats = jobChats(c);
    if (chats.length) r += "<h3>" + (chats.length > 1 ? "Chats on this job" : "Its chat") + '</h3><ul class="chats">' + chats.map((x) => '<li><a href="' + esc(x.link) + '" target="_blank" rel="noopener"><span>' + esc(x.title) + "</span>" + (x.touched ? "<small>" + esc(agoLong(x.touched)) + "</small>" : "") + "</a></li>").join("") + "</ul>";
    if (c.where) r += '<h3>Where</h3><div class="where"><code>' + esc(c.where) + '</code><button type="button" class="btn sm" data-bcopy>Copy</button></div>';
    $("b-s-rest").innerHTML = r;

    const link = chatLink(c.chat_url) || (jobChats(c)[0] || {}).link, snoozed = isSnoozed(c);
    let bar = link ? '<a class="btn ink open" href="' + esc(link) + '" target="_blank" rel="noopener">' + icon("open") + "Open chat</a>" : '<span class="btn ink open" aria-disabled="true">No chat link</span>';
    if (c.status === "done") bar += '<button type="button" class="btn" data-act="reopen">Reopen</button>';
    else bar += '<button type="button" class="btn post" data-act="done">Done</button><button type="button" class="btn" data-act="snooze" aria-expanded="' + S.snz + '">' + (snoozed ? "Snoozed" : "Snooze") + "</button>";
    bar += '<button type="button" class="btn" data-act="pin" aria-pressed="' + !!c.pinned + '">' + (c.pinned ? "Unpin" : "Pin") + "</button>";
    if (S.snz && c.status !== "done") bar += '<div class="snz"><button type="button" class="btn" data-snz="' + addDays(1) + '">Tomorrow<small>' + esc(dayDate(addDays(1))) + '</small></button><button type="button" class="btn" data-snz="' + nextMonday() + '">Next week<small>' + esc(dayDate(nextMonday())) + "</small></button>" + (snoozed ? '<button type="button" class="btn" data-snz="">Wake it now<small>back on the board</small></button>' : "") + "</div>";
    $("b-bar").innerHTML = bar;
    w.hidden = false;
  }
  function openSheet(id) {
    S.open = id; S.snz = false; $("b-ntext").value = ""; $("b-nsave").disabled = true;
    renderSheet(); $("b-sbody").scrollTop = 0; document.body.classList.add("locked"); L.toastUp(true);
    const t = document.querySelector("#b-sheet .close"); if (t) t.focus({ preventScroll: true });
  }
  /* ---------- replies (1.4.0, 25 Nov 2026) ---------- */
  /* A reply goes to the laptop, which types it into the job's chat in the Claude app and sends it. When the laptop
     can't (asleep, off, locked, or a Claude Code chat), one tap copies it and opens the chat in the Claude app here. */
  function renderReply() {
    const r = S.reply, box = $("b-nstat");
    if (!box) return;
    if (!r || r.card !== S.open) { box.innerHTML = ""; return; }
    if (r.state === "sending") { box.innerHTML = '<div class="nstat"><span class="spin" aria-hidden="true"></span><span>' + esc(r.message || "Sending it to the laptop") + "</span></div>"; return; }
    box.innerHTML = '<div class="nfall"><p><b>' + esc(r.title) + "</b> " + esc(r.message || "") + "</p><p>Copy it, and the chat opens in the Claude app: paste it there and tap Send.</p>" +
      '<div class="row"><a class="btn ink" data-rcopy href="' + esc(r.link) + '" target="_blank" rel="noopener">' + icon("open") + 'Copy and open the chat</a><button type="button" class="btn" data-rdrop>Not now</button></div></div>';
  }
  function settleCopied() {
    const r = S.reply;
    if (!r) return;
    addReply(r.card, r.text, "phone");
    S.reply = null;
    if (S.open === r.card) { if ($("b-ntext").value.trim() === r.text) { $("b-ntext").value = ""; $("b-nsave").disabled = true; } renderSheet(); }
  }
  async function reply(c, link, text) {
    if (S.reply && S.reply.state === "sending") { L.toast("Still sending your last reply."); return; }
    const hub = window.LEHub;
    const ready = hub && hub.replyReady ? hub.replyReady() : { ok: false, why: "" };
    S.reply = { card: c.id, text, link, state: "sending", title: "", message: ready.ok ? "Sending it to " + ready.pc : "" };
    if (!isChat(link) || !ready.ok) {
      Object.assign(S.reply, { state: "fallback", title: "Your phone sends this one.",
        message: !isChat(link) ? "Its chat is a Claude Code session, which the laptop can't type into." : ready.why });
      renderReply();
      return;
    }
    $("b-ntext").value = ""; $("b-nsave").disabled = true;
    renderReply();
    const res = await hub.sendReply(c.id, link, text, (d) => { if (S.reply && S.reply.text === text) { S.reply.message = d.message || S.reply.message; renderReply(); } });
    if (!S.reply || S.reply.text !== text) return; // put aside meanwhile
    if (res.state === "sent") {
      addReply(c.id, text, "laptop");
      S.reply = null;
      L.toast(res.message || "Sent to the chat.");
      if (S.open === c.id) renderSheet();
      return;
    }
    Object.assign(S.reply, { state: "fallback", title: res.state === "unsure" ? "Not sure it went." : "The laptop didn't send it.", message: res.message || "" });
    if (S.open === c.id) {
      if (!$("b-ntext").value) { $("b-ntext").value = text; $("b-nsave").disabled = false; }
      renderReply();
    } else {
      const r = S.reply;
      L.toast(r.title + " Copy it and open the chat?", () => { copyText(r.text); window.open(r.link, "_blank", "noopener"); settleCopied(); }, true, "Copy and open");
    }
  }
  function closeSheet() { S.open = null; S.snz = false; $("b-sheet").hidden = true; document.body.classList.remove("locked"); L.toastUp(false); }
  function render() { renderTop(); renderRail(); renderList(); if (S.open) renderSheet(); }

  /* ---------- events ---------- */
  function onClick(ev) {
    const t = ev.target;
    const v = t.closest("[data-view]");
    if (v) { S.view = v.getAttribute("data-view"); L.lsSet("board.view", S.view); if (S.q) { S.q = ""; $("b-q").value = ""; } renderRail(); renderList(); window.scrollTo({ top: 0 }); v.scrollIntoView({ block: "nearest", inline: "center" }); return; }
    if (t.closest("[data-breload]") || t.closest("#b-refresh")) { load(); return; }
    const o = t.closest("[data-open]"); if (o) { openSheet(o.getAttribute("data-open")); return; }
    if (t.closest("[data-bclose]")) { closeSheet(); return; }
    const c = S.open && cardById(S.open); if (!c) return;
    const mv = t.closest("[data-move]");
    if (mv) { const k = mv.getAttribute("data-move"); if (k !== c.move) change(c.id, { move: k }, "Now: " + MOVES[k]); return; }
    const sz = t.closest("[data-snz]");
    if (sz) { const to = sz.getAttribute("data-snz"); S.snz = false; change(c.id, { snooze_until: to || null }, to ? "Snoozed until " + dayDate(to) + ": " + c.title : "Back on the board: " + c.title, to ? closeSheet : null); return; }
    const a = t.closest("[data-act]");
    if (a) {
      const k = a.getAttribute("data-act");
      if (k === "done") change(c.id, { status: "done", done_at: nowIso() }, "Done: " + c.title, closeSheet);
      else if (k === "reopen") change(c.id, { status: "open", done_at: null }, "Reopened: " + c.title);
      else if (k === "pin") change(c.id, { pinned: !c.pinned }, c.pinned ? "Unpinned" : "Pinned to the top");
      else if (k === "snooze") { S.snz = !S.snz; renderSheet(); }
      return;
    }
    if (t.closest("[data-rcopy]")) { const r = S.reply; if (r) copyText(r.text); setTimeout(settleCopied, 400); return; } // the link opens the chat
    if (t.closest("[data-rdrop]")) { S.reply = null; renderReply(); return; }
    if (t.closest("[data-bcopy]")) { try { navigator.clipboard.writeText(c.where).then(() => L.toast("Copied"), () => L.toast("Couldn't copy that.")); } catch (e) { L.toast("Couldn't copy that."); } return; }
    if (S.snz && !t.closest(".snz")) { S.snz = false; renderSheet(); }
  }

  function init() {
    $("v-board").addEventListener("click", onClick);
    $("b-sheet").addEventListener("click", onClick);
    $("b-q").addEventListener("input", (ev) => { S.q = ev.target.value.trim(); renderRail(); renderList(); });
    $("b-ntext").addEventListener("input", (ev) => { $("b-nsave").disabled = !ev.target.value.trim(); });
    $("b-nform").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const c = S.open && cardById(S.open), text = $("b-ntext").value.trim();
      if (!c || !text) return;
      const link = chatLink(c.chat_url) || (jobChats(c)[0] || {}).link;
      if (link) { reply(c, link, text); return; }
      const at = nowIso(), note = { id: noteId(at), at, text, from: "phone" };
      $("b-ntext").value = ""; $("b-nsave").disabled = true;
      savePhone((ch) => M.addNote(ch, c.id, note, at)).then((ok) => {
        if (ok) L.toast("Note saved for Claude"); else if (!$("b-ntext").value) { $("b-ntext").value = text; $("b-nsave").disabled = false; }
      });
    });
    const cached = L.lsGet("board", null);
    if (cached && cached.base && Array.isArray(cached.base.cards)) {
      S.base = cached.base; S.changes = cached.changes || {}; S.phoneServer = cached.phone || { edits: {}, added: {} }; S.notes = cached.notes || []; S.cachedAt = cached.at || null;
      recompute();
    }
    render();
    setInterval(() => { if (!S.open && S.base && !document.hidden) render(); }, 10 * 60 * 1000);
  }
  function escape() { if (!S.open) return false; if (S.snz) { S.snz = false; renderSheet(); } else closeSheet(); return true; }
  function stale() { return !S.readAt || Date.now() - S.readAt > 90000; }

  window.LEBoard = { init, load, render, escape, stale, isOpen: () => !!S.open, _state: S };
})();
