# Loose Ends (phone app)

A small web app, installable on a phone's home screen, for a Loose Ends board and Work hub jobs kept in the
signed-in person's own OneDrive. It can also start a Work hub job on that person's own laptop.

- **No server and no data here.** These are static files on GitHub Pages. Everything is read from and written
  to the signed-in person's OneDrive through Microsoft Graph.
- **Sign-in.** Microsoft identity platform, authorisation code flow with PKCE, written out in `auth.js` (no
  libraries, no client secret). The ids in `config.js` are the app's registration, not secrets. Tokens stay
  on the phone.
- **Running a job on the laptop.** The app writes a signed request (ECDSA P-256; the key is made and kept on
  the phone) to OneDrive. A small program on the laptop checks it and starts the job. A request the laptop
  doesn't pick up within 10 minutes never runs.
- **Locked down.** The Content Security Policy only allows this site's own scripts, and network calls only to
  Microsoft sign-in, Graph and OneDrive.

Files: `index.html`, `styles.css`, `config.js`, `auth.js`, `graph.js`, `common.js`, `merge.js` (shared with
the desktop app), `board.js`, `workhub.js`, `app.js`, `sw.js` (keeps the app's files for weak signal; change
its `VERSION` with every release), `manifest.webmanifest`, `icons/`.
