# Loose Ends (phone app)

A small web app, installable on a phone's home screen, for a Loose Ends board and Work hub jobs kept in the
signed-in person's own OneDrive. It can also start a Work hub job on that person's own laptop, and its third tab,
Atlas, is a voice assistant for both.

- **No server and no data here.** These are static files on GitHub Pages. Everything is read from and written
  to the signed-in person's OneDrive through Microsoft Graph.
- **Sign-in.** Microsoft identity platform, authorisation code flow with PKCE, written out in `auth.js` (no
  libraries, no client secret). The ids in `config.js` are the app's registration, not secrets. Tokens stay
  on the phone.
- **Running a job on the laptop.** The app writes a signed request (ECDSA P-256; the key is made and kept on
  the phone) to OneDrive. A small program on the laptop checks it and starts the job. A request the laptop
  doesn't pick up within 10 minutes never runs.
- **Atlas.** Talks with Claude using the person's own Claude API key, pasted once and kept only on the phone
  (IndexedDB). Calls go straight from the phone to Anthropic's API (its browser access header), with no server
  in between. Listening and speaking use the phone's own dictation and voices (the Web Speech API); nothing is
  recorded. Anything that sends, posts, ticks or starts a job waits for a yes, tapped or said. Conversations
  can be saved to the person's OneDrive (Apps/Atlas/Conversations) for review, and that can be turned off.
- **Locked down.** The Content Security Policy only allows this site's own scripts, and network calls only to
  Microsoft sign-in, Graph, OneDrive and Anthropic's API.

Files: `index.html`, `styles.css`, `config.js`, `auth.js`, `graph.js`, `common.js`, `merge.js` (shared with
the desktop app), `board.js`, `workhub.js`, `atlas.js` and `atlas.css` (the Atlas tab), `app.js`, `sw.js`
(keeps the app's files for weak signal; change its `VERSION` with every release), `manifest.webmanifest`,
`icons/`.
