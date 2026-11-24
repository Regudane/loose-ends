/* Small things both tabs use: escaping, dates, storage on this phone, the toast and the yes-or-no box. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (n) => '<svg aria-hidden="true"><use href="#i-' + n + '"/></svg>';
  const lsGet = (k, d) => { try { const v = localStorage.getItem("le-app." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem("le-app." + k); else localStorage.setItem("le-app." + k, JSON.stringify(v)); } catch (e) {} };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

  /* ---------- dates, the same as the desktop app ---------- */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = () => isoDay(new Date());
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
  const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return isoDay(d); };
  const parseDate = (s) => { if (!s) return null; const d = new Date(String(s).length === 10 ? s + "T00:00:00" : s); return isNaN(d) ? null : d; };
  const fmtDate = (s) => { const d = parseDate(s); if (!d) return ""; return d.getDate() + " " + MON[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""); };
  const dayDate = (s) => { const d = parseDate(s); return d ? DAYS[d.getDay()] + " " + fmtDate(s) : ""; };
  const fmtTime = (s) => { const d = parseDate(s); if (!d) return ""; const h = d.getHours(); return ((h % 12) || 12) + ":" + pad(d.getMinutes()) + (h < 12 ? " am" : " pm"); };
  const daysSince = (s) => { const d = parseDate(s); if (!d) return null; const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()); let b = new Date(); b = new Date(b.getFullYear(), b.getMonth(), b.getDate()); return Math.max(0, Math.round((b - a) / 864e5)); };
  const when = (s) => { const n = daysSince(s); if (n == null) return ""; if (n === 0) return "today at " + fmtTime(s); if (n === 1) return "yesterday at " + fmtTime(s); if (n < 7) return DAYS[parseDate(s).getDay()] + " at " + fmtTime(s); return fmtDate(s); };
  const ago = (s) => { const n = daysSince(s); if (n == null) return ""; if (n === 0) return "today"; if (n === 1) return "1d"; if (n < 14) return n + "d"; if (n < 63) return Math.round(n / 7) + "w"; return Math.round(n / 30) + "mo"; };
  const agoLong = (s) => { const n = daysSince(s); if (n == null) return ""; if (n === 0) return "today"; if (n === 1) return "yesterday"; if (n < 14) return n + " days ago"; if (n < 63) return Math.round(n / 7) + " weeks ago"; return Math.round(n / 30) + " months ago"; };
  const minsAgo = (s) => { const d = parseDate(s); return d ? Math.max(0, Math.round((Date.now() - d.getTime()) / 60000)) : null; };
  const sinceShort = (s) => {
    const m = minsAgo(s);
    if (m == null) return "";
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 60 * 24) return Math.round(m / 60) + (Math.round(m / 60) === 1 ? " hour ago" : " hours ago");
    return when(s);
  };
  const nowIso = () => new Date().toISOString();
  /* 2026-11-24T09:41:07.123Z -> 20261124T094107Z, the time at the start of note and request names */
  const stamp = (iso) => String(iso || nowIso()).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

  /* ---------- the toast ---------- */
  let toastTimer = null;
  function toast(text, undo, bad, label) {
    const t = $("toast");
    t.innerHTML = "<span>" + esc(text) + "</span>" + (undo ? '<button type="button" id="t-undo">' + esc(label || "Undo") + "</button>" : '<button type="button" id="t-ok">OK</button>');
    t.classList.toggle("bad", !!bad);
    t.hidden = false;
    clearTimeout(toastTimer);
    $(undo ? "t-undo" : "t-ok").onclick = () => { t.hidden = true; if (undo) undo(); };
    if (!bad) toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 7000 : 4500);
  }
  function toastUp(on) { $("toast").classList.toggle("up", !!on); }

  /* ---------- a yes-or-no box (the system confirm() can't be styled or worded) ---------- */
  function ask(title, body, yes) {
    return new Promise((resolve) => {
      const w = $("ask");
      $("ask-t").textContent = title;
      $("ask-d").textContent = body;
      $("ask-yes").textContent = yes || "Yes";
      w.hidden = false;
      const done = (v) => { w.hidden = true; $("ask-yes").onclick = null; $("ask-no").onclick = null; resolve(v); };
      $("ask-yes").onclick = () => done(true);
      $("ask-no").onclick = () => done(false);
      setTimeout(() => $("ask-no").focus(), 30);
    });
  }

  /* ---------- a small key store on this phone (IndexedDB), for the pairing key ---------- */
  function idb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open("le-app", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((resolve, reject) => { const q = db.transaction("keys").objectStore("keys").get(k); q.onsuccess = () => resolve(q.result || null); q.onerror = () => reject(q.error); });
  }
  async function idbSet(k, v) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      if (v == null) tx.objectStore("keys").delete(k); else tx.objectStore("keys").put(v, k);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  }

  /* What a OneDrive problem means, in plain words. */
  function problemFor(e) {
    const code = (e && e.code) || "error";
    if (code === "signin") return "Microsoft wants you to sign in again.";
    if (code === "offline") return "No connection. Showing what was read last.";
    if (code === "missing") return (e && e.message) || "That isn't in your OneDrive.";
    if (code === "denied" || code === "accessDenied") return "Microsoft said no to reaching OneDrive. Sign out and in again from More.";
    if (code === "changed" || code === "exists") return "OneDrive was busy with that file. Try again.";
    if (code === "corrupt") return (e && e.message) || "A file won't read.";
    if (code === "not_configured") return "The app's Microsoft registration isn't done yet.";
    return "OneDrive said: " + String((e && e.message) || code).slice(0, 160);
  }

  window.LE = { $, esc, icon, lsGet, lsSet, clone, rand, MON, DAYS, pad, isoDay, today, addDays, nextMonday, parseDate, fmtDate, dayDate, fmtTime,
    daysSince, when, ago, agoLong, minsAgo, sinceShort, nowIso, stamp, toast, toastUp, ask, idbGet, idbSet, problemFor };
})();
