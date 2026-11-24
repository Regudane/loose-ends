/*
 * Loose Ends: how the card list is put together.
 *
 * data/cards.json is written by Claude (a "sweep my chats" or "update the board" chat):
 *   { "meta": { "last_sweep", "swept", "not_visible", "sweep_problem", "folded": { "<computer>": "<iso>" } },
 *     "cards": [ { "id", "title", "area", "move", "status", ... } ] }
 *
 * data/changes-<computer>.json is written only by the app on that computer, so two computers
 * never edit the same file and OneDrive never makes conflict copies:
 *   { "computer", "edits": { "<card id>": { "<field>": { "v": <value>, "at": "<iso>" } } },
 *     "added": { "<card id>": { ...card, "created_at": "<iso>" } } }
 *
 * When Claude sweeps, it folds every change into cards.json and records the time it folded each
 * computer's file in meta.folded. Anything newer than that time is laid over the top here.
 *
 * Notes from Claude chats (version 1.2, 19 Nov 2026). Any chat can drop a small note in data/inbox/
 * instead of rewriting cards.json, so a chat on Charlie's phone or in a Project can keep its card
 * current in one step, with the laptop on or off:
 *   data/inbox/<YYYYMMDDTHHMMSSZ>-<card id>-<4 letters>.json
 *   { "from": "<chat link>", "written_at": "<iso, UTC>", "upsert": [ { "id", ...card fields } ], "meta": { ... } }
 * The app lays the notes over the board straight away, oldest first, after Charlie's own changes, with
 * the same rule tools/board.py uses: a field Charlie changed in the app after the chat last touched the
 * card stays his (tldr, context and the catch-up are still refreshed). "chats" adds to the card's list
 * of chats instead of replacing it. When a chat folds the notes into cards.json (board.py save), it
 * lists each one in meta.inbox_folded and moves it to inbox/folded, so a note is never applied twice.
 * The app only reads the inbox. It never writes or moves a note.
 *
 * Charlie's notes for Claude (version 1.3, 24 Nov 2026). The Loose Ends page on his phone writes his
 * ticks to data/changes-phone.json, the same way this app writes changes-<computer>.json, and lets him
 * type a note for Claude on any card. Notes live in the card field "charlie_notes", a list that only
 * ever grows: [ { "id", "at", "text", "from" } ]. A note edit in a changes file holds that device's
 * whole list; it is added to the card's notes (matched by id) and never removes one. A note doesn't
 * count as Charlie changing the card, so it never stops a chat's update. A chat that has read the notes
 * sets "notes_read_at" (the "at" of the newest note it read); later notes show as new.
 * A change Charlie makes to a card that so far exists only in an inbox note goes on as soon as that
 * note makes the card, so a tick on a brand-new card isn't lost (also 1.3).
 */
(function (root) {
  "use strict";

  var NOTES = "charlie_notes";
  var EDITABLE = ["status", "done_at", "snooze_until", "move", "pinned", "title", "next", "area", "private", NOTES];
  var HIS = ["status", "done_at", "snooze_until", "move", "pinned", "title", "next", "area", "private"];
  var NOTE_DEFAULTS = { status: "open", move: "you", area: "personal", private: false, context: [], where: "",
    chat_url: null, snooze_until: null, pinned: false, done_at: null, source: "chat" };
  var META_KEEP = ["folded", "inbox_folded"]; // a note can't change these

  /* An ISO time as milliseconds (0 when missing), so "+11:00" and "Z" times compare correctly. */
  function ts(s) { var n = typeof s === "string" && s ? Date.parse(s) : NaN; return isNaN(n) ? 0 : n; }

  /* When a note was written: its written_at, or the time at the start of its file name. */
  function noteTime(note) {
    var d = (note && note.data) || {};
    if (typeof d.written_at === "string" && d.written_at) return d.written_at;
    var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec((note && note.name) || "");
    return m ? m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6] + ".000Z" : "";
  }

  /* A card's chats list only grows: a chat already listed (same link) is refreshed, a new one is added. */
  function mergeChats(have, add) {
    var out = (Array.isArray(have) ? have : []).filter(function (x) { return x && typeof x === "object"; })
      .map(function (x) { return Object.assign({}, x); });
    (Array.isArray(add) ? add : []).forEach(function (n) {
      if (!n || typeof n !== "object" || !n.url) return;
      var hit = null;
      out.forEach(function (o) { if (o.url === n.url) hit = o; });
      if (hit) Object.assign(hit, n); else out.push(Object.assign({}, n));
    });
    return out;
  }

  /* A note's id, or its time and text when it has no id. */
  function noteKey(n) { return typeof n.id === "string" && n.id ? n.id : (n.at || "") + "|" + (n.text || ""); }

  /* Charlie's notes only grow: a note already on the card (same id) is kept as it is, a new one is added.
     Oldest first. A note needs some text. The same steps as merge_notes in tools/board.py. */
  function mergeNotes(have, add) {
    var out = [], seen = {};
    (Array.isArray(have) ? have : []).concat(Array.isArray(add) ? add : []).forEach(function (n) {
      if (!n || typeof n !== "object" || Array.isArray(n) || typeof n.text !== "string" || !n.text.trim()) return;
      var k = noteKey(n);
      if (Object.prototype.hasOwnProperty.call(seen, k)) return;
      seen[k] = true;
      out.push(Object.assign({}, n));
    });
    return out.sort(function (a, b) {
      var d = ts(a.at) - ts(b.at); if (d) return d;
      var ka = noteKey(a), kb = noteKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  /* One of Charlie's changes, laid on a card. A note doesn't count as him changing the card. */
  function applyChange(c, fc, byTime) {
    if (fc.field === NOTES) { c[NOTES] = mergeNotes(c[NOTES], fc.v); return; }
    c[fc.field] = fc.v;
    var later = byTime ? ts(fc.at) > ts(c.updated_at) : (!c.updated_at || fc.at > c.updated_at);
    if (later) { c.updated_at = fc.at; c.updated_by = "you"; }
  }

  /* The same steps as apply_upserts in tools/board.py: keep the two in step.
     waiting: Charlie's changes to cards that only a note has made so far (no sweep has filed them
     yet). They go on as soon as the note makes the card, as if it had been there all along. */
  function applyUpserts(map, upserts, when, waiting) {
    (Array.isArray(upserts) ? upserts : []).forEach(function (u) {
      if (!u || typeof u !== "object" || typeof u.id !== "string" || !u.id) return;
      var c = map.get(u.id);
      if (!c) {
        var card = Object.assign({}, NOTE_DEFAULTS, { context: [] }, u, { id: u.id });
        if (Object.prototype.hasOwnProperty.call(card, NOTES)) card[NOTES] = mergeNotes([], card[NOTES]);
        if (!card.title) card.title = u.id;
        if (!card.last_touched) card.last_touched = when;
        card.updated_at = when; card.updated_by = "claude";
        map.set(u.id, card);
        if (waiting && Object.prototype.hasOwnProperty.call(waiting, u.id)) {
          waiting[u.id].forEach(function (fc) { applyChange(card, fc, true); });
          delete waiting[u.id];
        }
        return;
      }
      var touched = u.last_touched || when;
      var his = c.updated_by === "you" && ts(c.updated_at) > ts(touched);
      Object.keys(u).forEach(function (k) {
        if (k === "id" || (his && HIS.indexOf(k) !== -1)) return;
        c[k] = k === "chats" ? mergeChats(c.chats, u.chats) : k === NOTES ? mergeNotes(c[NOTES], u[NOTES]) : u[k];
      });
      if (!his) { c.updated_at = when; c.updated_by = "claude"; }
    });
  }

  function isFolded(meta, name) {
    var f = meta.inbox_folded;
    return !!f && typeof f === "object" && !Array.isArray(f) && Object.prototype.hasOwnProperty.call(f, name);
  }

  function applyNotes(map, meta, notes, waiting) {
    (Array.isArray(notes) ? notes : [])
      .filter(function (n) { return n && typeof n.name === "string" && n.data && typeof n.data === "object" && !Array.isArray(n.data) && !isFolded(meta, n.name); })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; })
      .forEach(function (n) {
        var when = noteTime(n);
        applyUpserts(map, n.data.upsert, when, waiting);
        var m = n.data.meta;
        if (m && typeof m === "object" && !Array.isArray(m)) {
          Object.keys(m).forEach(function (k) { if (META_KEEP.indexOf(k) === -1) meta[k] = m[k]; });
        }
      });
  }

  function mergeBoard(base, changesByComputer, notes) {
    base = base || {};
    var meta = Object.assign({}, base.meta || {});
    var folded = meta.folded || {};
    var map = new Map();
    (base.cards || []).forEach(function (c) { if (c && c.id) map.set(c.id, Object.assign({}, c)); });

    var fieldChanges = [];
    Object.keys(changesByComputer || {}).forEach(function (comp) {
      var ch = changesByComputer[comp] || {};
      var cut = folded[comp] || "";
      var added = ch.added || {};
      Object.keys(added).forEach(function (id) {
        var c = added[id];
        if (!c || map.has(id)) return;
        if ((c.created_at || "") <= cut) return;
        map.set(id, Object.assign({ status: "open", move: "you", area: "personal", context: [], source: "manual" }, c, { id: id }));
      });
      var edits = ch.edits || {};
      Object.keys(edits).forEach(function (id) {
        var fields = edits[id] || {};
        Object.keys(fields).forEach(function (f) {
          var e = fields[f];
          if (!e || EDITABLE.indexOf(f) === -1) return;
          if ((e.at || "") <= cut) return;
          fieldChanges.push({ id: id, field: f, v: e.v, at: e.at });
        });
      });
    });

    fieldChanges.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    var waiting = {};
    fieldChanges.forEach(function (fc) {
      var c = map.get(fc.id);
      if (!c) { (waiting[fc.id] = waiting[fc.id] || []).push(fc); return; }
      applyChange(c, fc, false);
    });

    applyNotes(map, meta, notes, waiting);
    return { meta: meta, cards: Array.from(map.values()) };
  }

  function setFields(changes, id, fields, at) {
    changes.edits = changes.edits || {};
    var e = changes.edits[id] = changes.edits[id] || {};
    Object.keys(fields).forEach(function (f) { e[f] = { v: fields[f], at: at }; });
    return changes;
  }

  /* Add one of Charlie's notes to a changes file: the edit holds the device's whole list of notes for that card. */
  function addNote(changes, id, note, at) {
    changes.edits = changes.edits || {};
    var e = changes.edits[id] = changes.edits[id] || {};
    var have = e[NOTES] && Array.isArray(e[NOTES].v) ? e[NOTES].v : [];
    e[NOTES] = { v: mergeNotes(have, [note]), at: at };
    return changes;
  }

  var api = { mergeBoard: mergeBoard, setFields: setFields, addNote: addNote, mergeNotes: mergeNotes, NOTES: NOTES,
    EDITABLE: EDITABLE, mergeChats: mergeChats, noteTime: noteTime };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LooseMerge = api;
})(typeof window !== "undefined" ? window : this);
