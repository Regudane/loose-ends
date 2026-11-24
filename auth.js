/*
  Sign-in with Microsoft for the Loose Ends phone app: OAuth 2.0 authorisation code flow with PKCE, the way a
  single-page app does it, written out by hand so the app downloads nothing (24 Nov 2026).

  - The sign-in page is Microsoft's own (login.microsoftonline.com). The app never sees the password.
  - There is no client secret: PKCE proves the app that asked for the code is the one swapping it for tokens.
  - The code comes back in the address's # part, so it never reaches the web server.
  - Tokens stay on this phone (localStorage). Microsoft gives a single-page app a refresh token that lasts
    24 hours, so once a day the app quietly asks Microsoft again (prompt=none). If Microsoft wants the password
    again, the Sign in screen comes back.
*/
(function () {
  "use strict";
  const C = window.LE_CONFIG || {};
  const SCOPES = "openid profile offline_access User.Read Files.ReadWrite";
  const KEY = "le-app.auth";
  const PEND = "le-app.auth-pending";
  const SILENT = "le-app.auth-silent-at";

  const b64url = (buf) => {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  /* The app's own address, which is also where Microsoft sends you back: https://<host>/loose-ends/ */
  const home = () => location.origin + location.pathname.replace(/[^/]*$/, "");
  const authority = () => "https://login.microsoftonline.com/" + encodeURIComponent(C.tenantId || "organizations");
  const configured = () => !!(C.clientId && C.tenantId);

  function claims(idToken) {
    try {
      const part = String(idToken || "").split(".")[1] || "";
      const json = decodeURIComponent(Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
      return JSON.parse(json);
    } catch (e) { return {}; }
  }

  async function signIn(opts) {
    opts = opts || {};
    if (!configured()) throw { code: "not_configured" };
    const verifier = rand(48);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = rand(18);
    write(PEND, { verifier, state, at: Date.now(), silent: !!opts.silent });
    const p = new URLSearchParams({
      client_id: C.clientId, response_type: "code", redirect_uri: home(), response_mode: "fragment",
      scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256",
    });
    const user = (read(KEY) || {}).user;
    if (opts.silent) p.set("prompt", "none");
    if (user && user.hint) p.set("login_hint", user.hint);
    location.assign(authority() + "/oauth2/v2.0/authorize?" + p.toString());
  }

  async function tokenCall(body) {
    let r;
    try {
      r = await fetch(authority() + "/oauth2/v2.0/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(),
      });
    } catch (e) { throw { code: "offline", message: "No connection to Microsoft." }; }
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw { code: j.error || "token_error", message: j.error_description || "Microsoft said " + r.status + "." };
    return j;
  }
  function keep(j) {
    const was = read(KEY) || {};
    const c = j.id_token ? claims(j.id_token) : null;
    const user = c ? { name: c.name || "", hint: c.preferred_username || c.upn || "", tid: c.tid || "" } : was.user || null;
    const t = {
      access: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      refresh: j.refresh_token || was.refresh || null, refreshFrom: j.refresh_token ? Date.now() : was.refreshFrom || Date.now(), user,
    };
    write(KEY, t);
    return t;
  }

  /* Called once when the app opens: finishes a sign-in that has just come back from Microsoft. */
  async function finish() {
    const h = location.hash.replace(/^#/, "");
    if (!/(^|&)(code|error)=/.test(h)) return null;
    const p = new URLSearchParams(h);
    const pend = read(PEND);
    write(PEND, null);
    history.replaceState(null, "", home());
    if (!pend || !p.get("state") || p.get("state") !== pend.state) return { error: "That sign-in didn't come from this app. Try again." };
    if (Date.now() - pend.at > 15 * 60000) return { error: "That sign-in took too long. Try again." };
    if (p.get("error")) {
      const quiet = pend.silent && /login_required|interaction_required|consent_required|account_selection_required/.test(p.get("error"));
      return quiet ? { needsSignIn: true } : { error: "Microsoft said: " + (p.get("error_description") || p.get("error")).split(/\r?\n/)[0].slice(0, 200) };
    }
    await tokenCall({ client_id: C.clientId, grant_type: "authorization_code", code: p.get("code"), redirect_uri: home(), code_verifier: pend.verifier, scope: SCOPES })
      .then(keep);
    return { ok: true };
  }

  let refreshing = null;
  /* A token for Microsoft Graph, refreshed when it's about to run out. Throws { code: "signin" } when only a
     new sign-in will do. */
  async function token() {
    const t = read(KEY);
    if (!t || (!t.access && !t.refresh)) throw { code: "signin" };
    if (t.access && t.exp - Date.now() > 120000) return t.access;
    if (!t.refresh) throw { code: "signin" };
    if (!refreshing) {
      refreshing = tokenCall({ client_id: C.clientId, grant_type: "refresh_token", refresh_token: t.refresh, scope: SCOPES })
        .then(keep, (e) => {
          if (e.code !== "offline") { write(KEY, { user: t.user }); throw { code: "signin", expired: true }; }
          throw e;
        })
        .finally(() => { refreshing = null; });
    }
    return (await refreshing).access;
  }
  /* Graph said the token is no good: drop it so the next call refreshes. */
  function expire() { const t = read(KEY); if (t) { t.exp = 0; write(KEY, t); } }

  /* When the 24-hour refresh token has run out: ask Microsoft quietly, at most once an hour. */
  function maySilent() { const at = Number(read(SILENT) || 0); return Date.now() - at > 3600000; }
  function silent() { write(SILENT, Date.now()); return signIn({ silent: true }); }

  function signedIn() { const t = read(KEY); return !!(t && (t.access || t.refresh)); }
  function user() { return (read(KEY) || {}).user || null; }
  function signOut() { write(KEY, null); write(SILENT, null); }

  window.LEAuth = { configured, signIn, finish, token, expire, signedIn, user, signOut, maySilent, silent, home };
})();
