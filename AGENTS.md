# AGENTS.md

Orchard is an Electron music player: Apple Music through MusicKit JS, plus a local FLAC-first library. The
renderer is plain HTML/CSS/JS served from a local HTTP server. No bundler, no framework, no TypeScript, no build
step — CommonJS everywhere.

## Commands

- `npm test` — all tests (Node's built-in runner; files in `test/*.test.js`).
- `node --test test/local-library.test.js` — one file; add `--test-name-pattern="..."` for one test.
- `node --check <file>` — the only static check; there is no lint, format, or typecheck script.
- `npm start` — run the app. The first run downloads castLabs Electron and Widevine; `.npmrc` allows the remote tarball.
- `./install.sh` — install/update into `~/.local/share/orchard`; refuses while Orchard is running.
- `npm run dist:linux` / `npm run dist:win` — package. Windows needs castLabs VMP signing (`build/vmp-sign.js`, `castlabs-evs`).

## How it is wired

- `main.js` serves `ui/` at `http://127.0.0.1:47533` (ephemeral fallback) and loads that URL. The renderer has an
  HTTP origin, not `file://`: new assets belong in `ui/` and go through `serve()`. `/media?path=<encoded absolute
  path>` streams local audio and covers with Range support; `isMedia` gates it by extension.
- `preload.js` is the only renderer→main boundary (`window.glass.*`). Add an IPC handler in `main.js` and expose it
  there; the renderer never gets Node.
- `ui/index.html` loads `lyrics.js` → `queue.js` → `app.js`, then MusicKit from Apple's CDN async. `app.js` executes
  before MusicKit exists: never touch `window.MusicKit` at top level; it waits for `musickitloaded`. `music` stays
  null until `start()` resolves, so Apple paths must tolerate it.
- Two engines share the UI: Apple Music and local files (`#localAudio`). `localMode`/`localItem()` says which is
  current; starting one must stop the other (`leaveLocal()` / `music.pause()`). The full seek input `#seek` is a
  0–1 fraction (`step="0.001"`), not seconds.
- `ui/lyrics.js`, `ui/queue.js` and `ui/review.js` are classic-script IIFEs with a `module.exports` guard so tests
  can require them. Keep them dependency-free and CommonJS-testable.
- `local-library.js` is pure Node (no Electron) so it can be tested; it parses FLAC/ID3v2/MP4/WAV by hand with no
  dependencies. Library data lives in Electron `userData` (`local-library.json`, `local-cache.json`,
  `local-lyrics.json`, `artist-photos.json`, `covers/`), not in the repo.
- `spotify.js` is pure Node: it turns a playlist link into an id and reads either the public embed page's
  `__NEXT_DATA__` (no credentials, first 50 tracks) or the Web API with the user's client id/secret (whole
  playlist, client-credentials token, 100 a page). Apple matching happens in
  `recommendations.matchSongs`, and the playlist is created through `amp()` in the renderer.
- `recommendations.js` is pure Node too: Last.fm's API and Apple catalogue search. The exact list comes from
  `main.js` reading `last.fm/music/+recommended/{artists,albums}` in a hidden window on the `persist:lastfm`
  partition (the page is server-rendered and bot-challenged, so it needs a real browser and a sign-in); the
  helpers `artistFromHref`/`albumFromHref` pull the names out of its links. That window is one at a time, has
  images off, is capped at 45 s and is always destroyed; the result is cached for the day. Without it,
  `recommendArtists` walks `artist.getsimilar` from the overall top artists (or `user.getRecommendedArtists`
  with an API session). Signing is md5 of the sorted parameters plus the secret. The renderer turns Apple
  resources into items with `toItem()`; the playlist is created through `amp()`.
- Local lyrics: `main.js` runs the LRCLIB job after a scan and on request, writes `<song>.lrc`, and embeds synced
  words into FLAC `VORBIS_COMMENT`; `lyricsFor()` reads the sidecar first, then the file. The lyrics stage uses
  Deezer artist photos cached in `artist-photos.json`. Hand-built playlists live in `localStorage` under
  `glass.playlists`; album multi-select is in-memory only.
- `mpris.js` publishes `org.mpris.MediaPlayer2.orchard`. The renderer reports state via `glass.mprisState`; main
  sends actions back via `glass.onMpris`. Both engines must report.
- Themes: Glass is `style.css` (`data-theme="aero"`), Night is `themes.css`; `prefs.theme` is `aero`/`night`, and a
  saved `catppuccin` migrates to `night`. Accent, tints and background are computed from the cover in `app.js` (CSS
  variables on `:root`), not fixed per theme.
- Renderer state lives in `localStorage`: `glass.prefs`, `glass.plays`, `glass.favs`, `glass.recent`.

## Traps

- `webSecurity: false` and `autoplayPolicy: "no-user-gesture-required"` in `main.js` are deliberate Cider-style
  settings (Apple's cross-origin API, cover-art colour sampling, autoplay). Don't remove them.
- Preferences are origin-scoped: the fixed port 47533 keeps `localStorage` across launches. If the port falls back
  to an ephemeral one, settings and play counts look reset for that run.
- `package.json` `build.files` is an explicit allowlist of main-process modules; adding a top-level `.js` means
  updating it. `install.sh` copies files by its own explicit `cp` list too — keep both in sync.
- Tests build synthetic binary fixtures (buffers and temp dirs); don't add real media files.
  `test/local-library.test.js` documents the FLAC/ID3/MP4/WAV byte layouts.
- `QueueEdit` only edits items after the current one; history and the playing song are intentionally immutable.
- `PRODUCT.md` is the product record (used by Impeccable); `DESIGN.md` is the token and component contract;
  `README.md` is user-facing. Update them when behaviour changes.
- The Apple token comes from the music.apple.com web player or `APPLE_MUSIC_DEVELOPER_TOKEN`; sign-in uses Apple's
  own page in a child window. Don't invent an auth flow.
- Running from a Chromium-based terminal can crash castLabs Electron's zygote; `unset CHROME_DESKTOP` before
  `npm start` (the installed launcher already does).

## Verify

- `npm test`, plus `node --check` on every edited JS file.
- Playback, MPRIS and the media server can't be proven by tests: run `npm start` before claiming they work.
