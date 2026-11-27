/*
  OneDrive through Microsoft Graph, for the Loose Ends phone app. Only paths in the signed-in person's own
  OneDrive ("me/drive"). File contents are read from Graph's short-lived download link, which needs no sign-in
  header and so works from a web page (Graph's /content answers with a redirect a page can't follow).
*/
(function () {
  "use strict";
  const G = "https://graph.microsoft.com/v1.0";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const enc = (path) => String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");

  async function call(method, url, opts) {
    opts = opts || {};
    for (let attempt = 0; ; attempt++) {
      const token = await window.LEAuth.token();
      let r;
      try {
        r = await fetch(/^https:/.test(url) ? url : G + url, {
          method, cache: "no-store", body: opts.body,
          headers: Object.assign({ Authorization: "Bearer " + token }, opts.headers || {}),
        });
      } catch (e) { throw { code: "offline", message: "No connection to OneDrive." }; }
      if (r.status === 401 && attempt === 0) { window.LEAuth.expire(); continue; }
      if ((r.status === 429 || r.status === 503 || r.status === 504) && attempt < 2) {
        await wait(Math.min((Number(r.headers.get("Retry-After")) || 1.5) * 1000, 8000));
        continue;
      }
      return r;
    }
  }
  async function problem(r) {
    let j = {};
    try { j = await r.json(); } catch (e) {}
    const e = (j && j.error) || {};
    const code = r.status === 404 ? "missing" : r.status === 412 ? "changed" : r.status === 409 ? "exists" : r.status === 403 ? "denied" : (e.code || "http_" + r.status);
    return { code, status: r.status, message: e.message || "OneDrive said " + r.status + "." };
  }

  /* Everything in a folder, with a download link for each file. */
  async function list(path) {
    let url = "/me/drive/root:/" + enc(path) + ":/children?$top=999";
    const out = [];
    while (url) {
      const r = await call("GET", url);
      if (!r.ok) throw await problem(r);
      const j = await r.json();
      (j.value || []).forEach((x) => out.push(x));
      url = j["@odata.nextLink"] || null;
    }
    return out;
  }
  /* One file or folder's details (with a fresh download link), or null if it isn't there. */
  async function item(path) {
    const r = await call("GET", "/me/drive/root:/" + enc(path));
    if (r.status === 404) return null;
    if (!r.ok) throw await problem(r);
    return r.json();
  }
  async function text(it) {
    let link = it && it["@microsoft.graph.downloadUrl"];
    if (!link && it && it.id) {
      const r = await call("GET", "/me/drive/items/" + encodeURIComponent(it.id));
      if (!r.ok) throw await problem(r);
      link = (await r.json())["@microsoft.graph.downloadUrl"];
    }
    if (!link) throw { code: "missing", message: "OneDrive gave no way to read that file." };
    let r;
    try { r = await fetch(link, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }); }
    catch (e) { throw { code: "offline", message: "No connection to OneDrive." }; }
    if (!r.ok) throw await problem(r);
    return r.text();
  }
  const parse = (t) => JSON.parse(String(t).replace(/^﻿/, ""));
  /* A JSON file: { data, eTag }, or null if it isn't there. Throws { code: "corrupt" } if it won't read as JSON. */
  async function readJson(path) {
    const it = await item(path);
    if (!it) return null;
    const t = await text(it);
    try { return { data: parse(t), eTag: it.eTag, item: it }; } catch (e) { throw { code: "corrupt", message: path.split("/").pop() + " won't read as JSON." }; }
  }
  /* Writes a JSON file. opts.ifMatch: only if it hasn't changed since (its eTag). opts.create: only if it isn't
     there yet (never over another file). */
  async function putJson(path, obj, opts) {
    opts = opts || {};
    const headers = { "Content-Type": "application/json" };
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    const q = opts.create ? "?@microsoft.graph.conflictBehavior=fail" : "";
    const r = await call("PUT", "/me/drive/root:/" + enc(path) + ":/content" + q, { headers, body: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) + "\n" });
    if (!r.ok) throw await problem(r);
    return r.json();
  }

  /* Writes a text file (Atlas's saved conversations, 1.5.0), over any file of that name. */
  async function putText(path, body, type) {
    const r = await call("PUT", "/me/drive/root:/" + enc(path) + ":/content", { headers: { "Content-Type": type || "text/plain; charset=utf-8" }, body });
    if (!r.ok) throw await problem(r);
    return r.json();
  }

  window.LEGraph = { list, item, text, parse, readJson, putJson, putText };
})();
