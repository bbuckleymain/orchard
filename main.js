// Orchard: a small Apple Music player for Linux, styled after GlassPlayer.
// Works the way Cider does: Apple's own MusicKit JS runs in castLabs Electron (Chromium + Widevine),
// with music.apple.com's public developer token and Apple's own sign-in page.
// See CREDITS.md for the projects this draws on (GlassPlayer, Cider).
const { app, BrowserWindow, components, ipcMain, session, safeStorage, dialog, shell } = require("electron");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const lyricsSources = require("./lyrics-sources");
const mpris = require("./mpris");
const lastfm = require("./lastfm");
const recommendations = require("./recommendations");
const spotify = require("./spotify");
const { LocalLibrary, isMedia, writeFlacLyrics } = require("./local-library");

// On Linux Orchard publishes its own MPRIS player (see mpris.js), so Chromium's anonymous one is turned off:
// two players for the same song would make scrobblers count it twice.
if (process.platform === "linux") app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const WEB = "https://music.apple.com";
const store = path.join(app.getPath("userData"), "account.bin");
let win = null, port = 0, localLib = null;

// ---- saved Apple Music sign-in (encrypted with the system keyring when available) ----
// Without a keyring nothing is written to disk: the sign-in lasts until Orchard closes.
let memAccount = null;
function loadAccount() {
  if (memAccount) return memAccount;
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(store))); } catch { return null; }
}
function saveAccount(acc) {
  if (!safeStorage.isEncryptionAvailable()) { memAccount = acc; return; }
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, safeStorage.encryptString(JSON.stringify(acc)), { mode: 0o600 });
}

// ---- developer token: read from the music.apple.com web player, like GlassPlayer does for SoundCloud ----
let devToken = null;
async function token(refresh = false) {
  if (process.env.APPLE_MUSIC_DEVELOPER_TOKEN) return process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  if (devToken && !refresh) return devToken;
  const get = url => fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) }).then(r => r.text());
  const html = await get(WEB + "/us/browse");
  const scripts = [...html.matchAll(/<script[^>]+src="(\/assets\/[^"]+\.js)"/g)].map(m => WEB + m[1]);
  for (const url of scripts) {
    try {
      const js = await get(url);
      for (const [jwt] of js.matchAll(/eyJ[\w-]{10,}\.eyJ[\w-]+\.[\w-]+/g)) {
        try { if (JSON.parse(Buffer.from(jwt.split(".")[0], "base64url")).alg === "ES256") return (devToken = jwt); } catch {}
      }
    } catch {}
  }
  throw new Error("Couldn't reach Apple Music.");
}

// ---- the UI is served from localhost, like Cider ----
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".avif": "image/avif", ".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".aiff": "audio/aiff", ".aif": "audio/aiff" };

// Audio and cover art for the local library. Ranges are honoured so seeking in a FLAC works
// without the browser having to download the whole file first.
function serveMedia(req, res) {
  let file;
  try { file = new URL(req.url, "http://127.0.0.1").searchParams.get("path"); } catch { res.writeHead(400).end(); return; }
  if (!file || !isMedia(file)) { res.writeHead(403).end(); return; }
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404).end(); return; }
  if (!stat.isFile()) { res.writeHead(404).end(); return; }
  const ext = path.extname(file).toLowerCase(), type = TYPES[ext] || "application/octet-stream";
  const cache = /^\.(jpg|jpeg|png|webp|gif|avif)$/.test(ext) ? "public, max-age=86400" : "no-cache";
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1, "Content-Type": type, "Cache-Control": cache });
      if (req.method === "HEAD") res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { "Content-Length": stat.size, "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache });
  if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res);
}

function serve() {
  const root = path.join(__dirname, "ui");
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/media?")) { serveMedia(req, res); return; }
    let file;
    try { file = path.join(root, path.normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "")); }
    catch { res.writeHead(400).end(); return; }   // a malformed %-escape or null byte
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(file.endsWith(path.sep) ? path.join(file, "index.html") : file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  });
  // A fixed port keeps the page's origin (and so its saved settings) the same between launches.
  return new Promise(resolve => {
    server.once("error", () => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    server.listen(47533, "127.0.0.1", () => resolve(server.address().port));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 700, minWidth: 880, minHeight: 600,
    frame: false, backgroundColor: "#ece7f1", title: "Orchard", show: false,
    icon: path.join(__dirname, "ui", "orchard.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      webSecurity: false,             // same as Cider: Apple's APIs only answer music.apple.com
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.webContents.setUserAgent(UA);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}/`)) e.preventDefault(); });
  win.once("ready-to-show", () => win.show());
  win.loadURL(`http://127.0.0.1:${port}/index.html`);
}

// Apple's sign-in, done the Cider way: open the real music.apple.com, let the user sign in there,
// then hand the resulting Music User Token to the player.
let authWin = null;
function signIn() {
  if (authWin) { authWin.focus(); return Promise.resolve(null); }
  return new Promise(resolve => {
    authWin = new BrowserWindow({
      width: 520, height: 760, parent: win, title: "Sign in to Apple Music", backgroundColor: "#1d1d1f", autoHideMenuBar: true,
      webPreferences: { partition: "persist:apple-signin", contextIsolation: true },
    });
    authWin.webContents.setUserAgent(UA);
    authWin.loadURL(WEB + "/us/browse");
    let clicked = false, done = false;
    const poll = setInterval(async () => {
      if (!authWin || authWin.isDestroyed()) return;
      try {
        const r = await authWin.webContents.executeJavaScript(`(() => {
          if (typeof MusicKit === 'undefined') return null;
          const m = MusicKit.getInstance();
          if (m && m.isAuthorized && m.musicUserToken) return { token: m.musicUserToken, storefront: m.storefrontCountryCode || m.storefrontId || '' };
          if (!${clicked}) { const b = [...document.querySelectorAll('button, a')].find(e => /^\s*sign in\s*$/i.test(e.textContent)); if (b) { b.click(); return 'clicked'; } }
          return null;
        })()`);
        if (r === "clicked") clicked = true;
        else if (r && r.token) {
          done = true;
          const acc = { token: r.token, storefront: r.storefront };
          saveAccount(acc);
          authWin.close();
          resolve(acc);
        }
      } catch {}
    }, 800);
    authWin.on("closed", () => { clearInterval(poll); authWin = null; if (!done) resolve(null); });
  });
}

async function signOut() {
  memAccount = null;
  try { fs.unlinkSync(store); } catch {}
  await session.fromPartition("persist:apple-signin").clearStorageData();
}

ipcMain.handle("token", (_e, refresh) => token(refresh));
ipcMain.handle("account", () => loadAccount());
ipcMain.handle("lyrics-external", (_e, q) => lyricsSources.external(q));

// Your API keys (Musixmatch, Last.fm), encrypted with the system keyring like the Apple sign-in.
// With no keyring they're kept for this run only.
const secrets = {};
const secretPath = name => path.join(app.getPath("userData"), name + ".bin");
function loadSecret(name) {
  if (secrets[name] != null) return secrets[name];
  try { return (secrets[name] = safeStorage.decryptString(fs.readFileSync(secretPath(name)))); } catch { return ""; }
}
function saveSecret(name, value) {
  secrets[name] = value;
  if (!value) { try { fs.unlinkSync(secretPath(name)); } catch {} return; }
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.mkdirSync(path.dirname(secretPath(name)), { recursive: true });
  fs.writeFileSync(secretPath(name), safeStorage.encryptString(value), { mode: 0o600 });
}
function loadMusixmatchKey() { lyricsSources.setMusixmatchKey(loadSecret("musixmatch")); }
ipcMain.handle("musixmatch-status", () => lyricsSources.musixmatchStatus());
ipcMain.handle("musixmatch-key", (_e, key) => {
  key = String(key || "").trim();
  saveSecret("musixmatch", key);
  lyricsSources.setMusixmatchKey(key);
  return lyricsSources.musixmatchStatus();
});

// Most-played Last.fm songs, found on Apple Music. The UI then favourites them with your Apple sign-in.
ipcMain.handle("lastfm-status", () => !!loadSecret("lastfm"));
// A key is checked before it replaces a working one: pasting the API secret into the key box is an easy
// mistake, and Last.fm's answer to it is a 403 that used to look like a network fault.
ipcMain.handle("lastfm-key", async (_e, key) => {
  const value = String(key || "").trim();
  if (value) {
    const bad = await recommendations.checkKey({ key: value });
    if (bad) return { has: !!loadSecret("lastfm"), error: bad };
  }
  saveSecret("lastfm", value);
  return { has: !!loadSecret("lastfm"), error: "" };
});

// The API secret and the session key exist only so Orchard can ask Last.fm for the same recommendations its
// own Suggested page shows. They are encrypted like the key and never reach the renderer.
const lastfmAuth = () => ({
  hasKey: !!loadSecret("lastfm"),
  hasSecret: !!loadSecret("lastfm-secret"),
  user: loadSecret("lastfm-session-name") || "",
  page: !!loadSecret("lastfm-page"),
  pending: !!loadSecret("lastfm-pending-token") && !loadSecret("lastfm-session"),
});
ipcMain.handle("lastfm-auth", async () => { await lastfmResume(); return lastfmAuth(); });
ipcMain.handle("lastfm-secret", (_e, value) => {
  const next = String(value || "").trim();
  if (next !== loadSecret("lastfm-secret")) {          // a new secret invalidates the old session
    saveSecret("lastfm-session", "");
    saveSecret("lastfm-session-name", "");
    saveSecret("lastfm-pending-token", "");
  }
  saveSecret("lastfm-secret", next);
  return lastfmAuth();
});
ipcMain.handle("lastfm-disconnect", () => {
  saveSecret("lastfm-session", "");
  saveSecret("lastfm-session-name", "");
  saveSecret("lastfm-pending-token", "");
  return lastfmAuth();
});

const sleep = ms => new Promise(done => setTimeout(done, ms));
let connecting = null;

// ---- the Suggested page itself, read in a real browser window -----------------------------------
// Last.fm renders /music/+recommended/artists for the signed-in account, and its public copy is behind a
// bot challenge, so it is loaded in a window sharing a persistent Last.fm login. That page is the only
// source that matches Last.fm exactly; the API methods below are fallbacks for when nobody is signed in.
const LFM_PARTITION = "persist:lastfm";
const LFM_URL = /^https:\/\/([a-z0-9-]+\.)?last\.fm(\/|$)/i;

function lfmWindow(show) {
  const w = new BrowserWindow({
    show, width: 520, height: 760, title: "Last.fm", autoHideMenuBar: true, backgroundColor: "#1c1c1c",
    // No images: the tiles' own link still holds an <img> element, so the read below is unaffected, but the
    // page costs a fraction of the memory and bandwidth. The window is short-lived and always destroyed.
    webPreferences: { partition: LFM_PARTITION, contextIsolation: true, images: false, backgroundThrottling: true },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e, url) => { if (!LFM_URL.test(url)) e.preventDefault(); });
  return w;
}

function lastfmLogin() {
  return new Promise(resolve => {
    const w = lfmWindow(true);
    w.loadURL("https://www.last.fm/login");
    w.on("closed", resolve);
  });
}

// The tile's own link carries the cover; the "Similar to …" links further down the tile are plain text, so
// preferring the link with an image picks the recommendation and not the artists it was derived from.
async function lfmTiles(w, url, selector) {
  await w.loadURL(url);
  return w.webContents.executeJavaScript(`(async () => {
    const until = Date.now() + 20000;
    let box = null;
    while (Date.now() < until) {
      box = document.querySelector(${JSON.stringify(selector)}) || document.querySelector('[class*="music-recommended"]');
      if (box) break;
      await new Promise(r => setTimeout(r, 400));
    }
    if (!box) return null;
    return [...box.querySelectorAll(':scope > li')].map(li => {
      const links = [...li.querySelectorAll('a[href^="/music/"]')];
      const own = links.find(a => a.querySelector('img')) || links[0];
      return own ? own.getAttribute('href') : '';
    }).filter(Boolean);
  })()`, true);
}

// One scrape at a time: pressing Create and Refresh together must not open two hidden windows. The whole
// read is capped, and the window is always destroyed.
let scraping = null;
function lfmSuggestedPage() {
  if (scraping) return scraping;
  scraping = (async () => {
    const w = lfmWindow(false);
    const cap = setTimeout(() => { try { w.destroy(); } catch {} }, 45000);
    try {
      const artistHrefs = await lfmTiles(w, "https://www.last.fm/music/+recommended/artists", ".music-recommended-artists");
      if (!artistHrefs?.length) { saveSecret("lastfm-page", ""); return null; }
      const albumHrefs = await lfmTiles(w, "https://www.last.fm/music/+recommended/albums", ".music-recommended-albums");
      saveSecret("lastfm-page", "1");
      return {
        artists: artistHrefs.map(h => recommendations.artistFromHref(h)).filter(Boolean).map(name => ({ name })),
        albums: (albumHrefs || []).map(h => recommendations.albumFromHref(h)).filter(Boolean),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(cap);
      try { w.destroy(); } catch {}
    }
  })().finally(() => { scraping = null; });
  return scraping;
}

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
let pageCache = null;                      // { day, value } so opening the tab again doesn't re-read Last.fm

// Only after a Last.fm sign-in has worked once: otherwise every page load would open a hidden window for
// nothing. A failed read clears the flag, so the next attempt goes straight to the API.
async function pageSuggestions({ fresh = false } = {}) {
  if (!loadSecret("lastfm-page")) return null;
  if (!fresh && pageCache?.day === localDay()) return pageCache.value;
  const page = await lfmSuggestedPage();
  if (!page?.artists?.length) return null;
  pageCache = { day: localDay(), value: page };
  return page;
}

ipcMain.handle("lastfm-login", async () => {
  await lastfmLogin();
  pageCache = null;
  const page = await lfmSuggestedPage().catch(() => null);
  return { signedIn: !!page?.artists?.length, page: lastfmAuth() };
});
ipcMain.handle("lastfm-page", async () => lfmSuggestedPage());
ipcMain.handle("lastfm-signout", async () => {
  saveSecret("lastfm-page", "");
  pageCache = null;
  try { await session.fromPartition(LFM_PARTITION).clearStorageData(); } catch {}
  return lastfmAuth();
});

// The token from auth.getToken is kept until it is used, so a late approval on last.fm still completes:
// opening Settings again (or pressing Connect) picks it up instead of starting over.
async function lastfmResume() {
  const key = loadSecret("lastfm"), secret = loadSecret("lastfm-secret");
  const token = loadSecret("lastfm-pending-token");
  if (!key || !secret || !token || loadSecret("lastfm-session")) return;
  try {
    const session = await recommendations.authGetSession({ key, secret, token });
    if (!session.key) return;
    saveSecret("lastfm-session", session.key);
    saveSecret("lastfm-session-name", session.name);
    saveSecret("lastfm-pending-token", "");
  } catch (e) {
    // 14 means "not allowed yet" (keep waiting); an expired or unknown token can be thrown away.
    if (/invalid token|expired/i.test(e?.message || "")) saveSecret("lastfm-pending-token", "");
  }
}

// Desktop auth: ask for a token, send the user to last.fm to allow Orchard, then poll for the session key.
// The user's browser does the signing in, so no Last.fm password ever passes through the app.
function lastfmConnect() {
  const key = loadSecret("lastfm"), secret = loadSecret("lastfm-secret");
  if (!key || !secret) return Promise.reject(new Error("Save your Last.fm API key and secret first."));
  if (connecting) return connecting;
  connecting = (async () => {
    const { token } = await recommendations.authGetToken({ key, secret });
    if (!token) throw new Error("Last.fm didn't return a token.");
    saveSecret("lastfm-pending-token", token);
    await shell.openExternal(`https://www.last.fm/api/auth/?api_key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`);
    // Ten minutes: signing in to last.fm before allowing the app can easily take longer than a few.
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await sleep(2500);
      try {
        const session = await recommendations.authGetSession({ key, secret, token });
        if (!session.key) throw new Error("Last.fm returned an empty session.");
        saveSecret("lastfm-session", session.key);
        saveSecret("lastfm-session-name", session.name);
        saveSecret("lastfm-pending-token", "");
        return lastfmAuth();
      } catch (e) {
        if (!/not been authori[sz]ed|unauthori[sz]ed token/i.test(e?.message || "")) throw e;
      }
    }
    throw new Error("Last.fm hasn't confirmed yet. Allow Orchard in the browser, then open Settings again.");
  })().finally(() => { connecting = null; });
  return connecting;
}
ipcMain.handle("lastfm-connect", () => lastfmConnect());
ipcMain.handle("lastfm-match", async (_e, { user, min }) => {
  const key = loadSecret("lastfm");
  user = String(user || "").trim();
  if (!key || !user) throw new Error("Enter your Last.fm username and save your API key first.");
  const tracks = await lastfm.topTracks({ user, key, min: Math.max(1, Math.floor(+min) || 10) });
  const storefront = (loadAccount()?.storefront || "us").toLowerCase();
  return { total: tracks.length, ...(await lastfm.matchAll(tracks, { token: await token(), storefront })) };
});

// Last.fm recommendations -> Apple Music. The signed-in Suggested page is read first (it is the exact list
// Last.fm shows); the API methods are the fallback. Matching runs here so the renderer never handles the
// developer token.
ipcMain.handle("lastfm-recommended", async (_e, query) => {
  const key = loadSecret("lastfm");
  try {
    const page = await pageSuggestions({ fresh: !!query?.fresh });
    if (page) return page;
    if (!key) return { error: "Sign in to Last.fm, or save your API key in Settings > Last.fm." };
    const user = String(query?.user || "").trim() || loadSecret("lastfm-session-name") || "";
    const known = Array.isArray(query?.known) ? query.known.map(String) : [];
    const artists = await recommendations.recommendArtists({
      user, key, secret: loadSecret("lastfm-secret"), sk: loadSecret("lastfm-session"), known,
    });
    const albums = await recommendations.albumsByArtists({ artists, key });
    return { artists, albums };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
});

ipcMain.handle("lastfm-suggested", async (_e, query) => {
  const key = loadSecret("lastfm");
  try {
    let artists = [], albums = [];
    const page = await pageSuggestions({ fresh: !!query?.fresh });
    if (page) ({ artists, albums } = page);
    else if (key) {
      const user = String(query?.user || "").trim() || loadSecret("lastfm-session-name") || "";
      const known = Array.isArray(query?.known) ? query.known.map(String) : [];
      artists = await recommendations.recommendArtists({
        user, key, secret: loadSecret("lastfm-secret"), sk: loadSecret("lastfm-session"), known,
      });
      albums = await recommendations.albumsByArtists({ artists, key });
    } else {
      return { error: "Sign in to Last.fm, or save your API key in Settings > Last.fm." };
    }
    const tok = await token();
    const storefront = (loadAccount()?.storefront || "us").toLowerCase();
    const [mAlbums, mArtists] = await Promise.all([
      recommendations.matchAlbums(albums, { token: tok, storefront }),
      recommendations.matchArtists(artists, { token: tok, storefront }),
    ]);
    const tracks = await recommendations.buildSuggestedTracks({
      albums: mAlbums, artists: mArtists, token: tok, storefront, maxTracks: 100,
    });
    return { albums: mAlbums, artists: mArtists, tracks };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
});
ipcMain.handle("sign-in", () => signIn());
ipcMain.handle("sign-out", () => signOut());

// A Spotify playlist, matched onto Apple Music. Reads the public embed page (no credentials) and returns the
// Apple song resources in playlist order, so the renderer can create the playlist the same way as Suggested.
ipcMain.handle("spotify-import", async (_e, query) => {
  try {
    const id = spotify.playlistId(query?.url);
    if (!id) return { error: "That doesn't look like a Spotify playlist link." };
    const list = await spotify.embed(id);
    const tok = await token();
    const storefront = (loadAccount()?.storefront || "us").toLowerCase();
    const matched = await recommendations.matchSongs(list.tracks, { token: tok, storefront });
    return {
      name: list.name,
      total: list.tracks.length,
      partial: list.partial,
      tracks: matched.filter(m => m.found).map(m => m.apple),
      missing: matched.filter(m => !m.found).map(m => `${m.artist} – ${m.title}`),
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
});

// ---- local files ----
// The library lives in userData; the renderer asks for it on launch and after every change.
// Scanning reports progress so a large folder doesn't look frozen.
const progressFor = sender => p => { try { sender.send("local-progress", p); } catch {} };
ipcMain.handle("local-library", () => localLib?.get() || { roots: [], tracks: [], albums: [], artists: [], excluded: [] });
ipcMain.handle("local-add", async (e, kind) => {
  if (!localLib) return null;
  const files = kind === "files";
  const options = {
    title: files ? "Add music files" : "Add a music folder",
    properties: files ? ["openFile", "multiSelections"] : ["openDirectory"],
    ...(files ? { filters: [{ name: "Audio", extensions: ["flac", "mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav", "aiff", "aif"] }] } : {}),
  };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths.length) return null;
  const state = await localLib.addPaths(picked.filePaths, progressFor(e.sender));
  if (state) runLyricsJob(missingLyrics(state.tracks), { sender: e.sender });
  return state;
});
ipcMain.handle("local-rescan", async e => {
  if (!localLib) return null;
  const state = await localLib.rescan(progressFor(e.sender));
  if (state) runLyricsJob(missingLyrics(state.tracks), { sender: e.sender });
  return state;
});
ipcMain.handle("local-remove-root", (_e, p) => localLib?.removeRoot(p) || null);
ipcMain.handle("local-remove-track", (_e, p) => localLib?.removeTrack(p) || null);
ipcMain.handle("local-clear", () => localLib?.clear() || null);
ipcMain.handle("local-lyrics", (_e, p) => localLib?.lyricsFor(p) || "");
ipcMain.handle("local-reveal", (_e, p) => { if (p) shell.showItemInFolder(p); });

// ---- lyrics: LRCLIB after a scan, embedded into FLAC, a sidecar for the rest --------------------
const SYNCED = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;
const isSyncedLyrics = text => SYNCED.test(String(text || ""));

function sidecarFor(file) {
  return path.join(path.dirname(file), path.basename(file, path.extname(file)) + ".lrc");
}

// A timed sidecar always replaces a plain one; a plain result only fills a gap.
function writeSidecar(file, text, force) {
  const dest = sidecarFor(file);
  try {
    if (!force && fs.existsSync(dest)) {
      const old = fs.readFileSync(dest, "utf8");
      if (isSyncedLyrics(old)) return false;
    }
    fs.writeFileSync(dest, String(text).replace(/\r\n/g, "\n"), "utf8");
    return true;
  } catch { return false; }
}

async function fetchLyricsFor(track, { force = false } = {}) {
  if (!track?.path) return { found: false };
  const info = localLib?.lyricsInfo(track.path);
  if (!force && info && info.mtimeMs === track.mtimeMs && info.done) {
    return { found: !!info.found, synced: !!info.synced, cached: true };
  }
  const existing = localLib?.lyricsFor(track.path) || "";
  if (!force && isSyncedLyrics(existing)) {
    localLib?.setLyricsInfo(track.path, { mtimeMs: track.mtimeMs, done: true, found: true, synced: true, source: "file" });
    return { found: true, synced: true, cached: true };
  }

  const found = await lyricsSources.lrclib(track.artist || "", track.title || "", track.album || "", (track.ms || 0) / 1000);
  if (!found || (!found.synced && !found.plain)) {
    localLib?.setLyricsInfo(track.path, { mtimeMs: track.mtimeMs, done: true, found: false, synced: false });
    return { found: false };
  }

  const text = found.synced || found.plain;
  const synced = !!found.synced;
  writeSidecar(track.path, text, force || synced);
  if (synced && path.extname(track.path).toLowerCase() === ".flac" && writeFlacLyrics(track.path, text)) {
    try {
      const st = fs.statSync(track.path);
      track.mtimeMs = st.mtimeMs;
      track.size = st.size;
      localLib?.save();
    } catch {}
  }
  localLib?.setLyricsInfo(track.path, { mtimeMs: track.mtimeMs, done: true, found: true, synced, source: "LRCLIB" });
  return { found: true, synced, text, source: "LRCLIB" };
}

function missingLyrics(tracks) {
  return (tracks || []).filter(t => {
    const info = localLib?.lyricsInfo(t.path);
    if (info && info.mtimeMs === t.mtimeMs && info.done) return false;
    return !isSyncedLyrics(localLib?.lyricsFor(t.path) || "");
  });
}

let lyricsJob = 0;
async function runLyricsJob(tracks, { force = false, sender = null } = {}) {
  if (!tracks.length) { try { sender?.send("local-lyrics-progress", { done: 0, total: 0, found: 0, finished: true }); } catch {} return; }
  const job = ++lyricsJob;
  const total = tracks.length;
  let done = 0, found = 0;
  const send = p => { try { sender?.send("local-lyrics-progress", p); } catch {} };
  for (let i = 0; i < tracks.length; i += 3) {
    if (job !== lyricsJob) break;
    const batch = tracks.slice(i, i + 3);
    const results = await Promise.all(batch.map(t => fetchLyricsFor(t, { force }).catch(() => ({ found: false }))));
    for (const r of results) if (r?.found) found++;
    done += batch.length;
    send({ done, total, found, file: batch[batch.length - 1]?.path || "", title: batch[batch.length - 1]?.title || "" });
  }
  send({ done: total, total, found, finished: true });
}

ipcMain.handle("local-fetch-lyrics", async (_e, file) => {
  if (!localLib) return null;
  const track = localLib.get().tracks.find(t => t.path === file);
  if (!track) return null;
  return fetchLyricsFor(track, { force: true });
});
ipcMain.handle("local-fetch-lyrics-missing", e => {
  if (!localLib) return { total: 0 };
  const todo = missingLyrics(localLib.get().tracks);
  runLyricsJob(todo, { sender: e.sender });
  return { total: todo.length };
});
ipcMain.handle("local-fetch-lyrics-all", e => {
  if (!localLib) return { total: 0 };
  const tracks = localLib.get().tracks;
  runLyricsJob(tracks, { force: true, sender: e.sender });
  return { total: tracks.length };
});

// ---- artist photos for the lyrics stage (Deezer, cached in userData) -----------------------------
const artistPhotoFile = () => path.join(app.getPath("userData"), "artist-photos.json");
let artistPhotos = {};
function loadArtistPhotos() {
  try { artistPhotos = JSON.parse(fs.readFileSync(artistPhotoFile(), "utf8")); } catch { artistPhotos = {}; }
}
function saveArtistPhotos() {
  try { fs.writeFileSync(artistPhotoFile(), JSON.stringify(artistPhotos)); } catch {}
}
async function artistPhoto(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return "";
  if (key in artistPhotos) return artistPhotos[key] || "";
  try {
    const r = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=1`, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const data = await r.json();
      const a = data?.data?.[0];
      const url = a?.picture_xl || a?.picture_big || a?.picture_medium || a?.picture || "";
      artistPhotos[key] = url;
      saveArtistPhotos();
      return url;
    }
  } catch {}
  artistPhotos[key] = "";
  saveArtistPhotos();
  return "";
}
ipcMain.handle("artist-photo", (_e, name) => artistPhoto(name));

ipcMain.on("window", (_e, action) => {
  if (!win) return;
  if (action === "close") win.close();
  else if (action === "min") win.minimize();
  else if (action === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
});

// On Windows this groups the taskbar icon and names Orchard in the media controls.
if (process.platform === "win32") app.setAppUserModelId("io.github.bbuckleymain.orchard");

// One Orchard at a time: two copies sharing a profile can corrupt it, and Apple only streams to one at once.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
});

app.whenReady().then(async () => {
  // Like Cider, the player's requests to Apple carry music.apple.com as their origin.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["https://*.apple.com/*"] }, (d, cb) => {
    if (win && d.webContentsId === win.webContents.id) {
      d.requestHeaders["Origin"] = WEB;
      d.requestHeaders["Referer"] = WEB + "/";
    }
    cb({ requestHeaders: d.requestHeaders });
  });
  port = await serve();
  loadArtistPhotos();
  localLib = new LocalLibrary(app.getPath("userData"));
  loadMusixmatchKey();
  await components.whenReady(); // Widevine CDM is downloaded/updated here on first launch
  console.log("[Orchard] Widevine:", JSON.stringify(components.status()));
  createWindow();
  if (process.platform === "linux") {
    const update = await mpris.start({
      send: msg => win?.webContents.send("mpris", msg),
      raise: () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } },
      quit: () => app.quit(),
    });
    if (update) ipcMain.on("mpris-state", (_e, state) => update(state));
  }
});

app.on("window-all-closed", () => app.quit());
