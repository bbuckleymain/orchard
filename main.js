// Orchard: a small Apple Music player for Linux, styled after GlassPlayer.
// Works the way Cider does: Apple's own MusicKit JS runs in castLabs Electron (Chromium + Widevine),
// with music.apple.com's public developer token and Apple's own sign-in page.
// See CREDITS.md for the projects this draws on (GlassPlayer, Cider).
const { app, BrowserWindow, components, ipcMain, session, safeStorage } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const lyricsSources = require("./lyrics-sources");
const mpris = require("./mpris");

// On Linux Orchard publishes its own MPRIS player (see mpris.js), so Chromium's anonymous one is turned off:
// two players for the same song would make scrobblers count it twice.
if (process.platform === "linux") app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const WEB = "https://music.apple.com";
const store = path.join(app.getPath("userData"), "account.bin");
let win = null, port = 0;

// ---- saved Apple Music sign-in (encrypted with the system keyring when available) ----
function loadAccount() {
  try {
    const raw = fs.readFileSync(store);
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString();
    return JSON.parse(json);
  } catch { return null; }
}
function saveAccount(acc) {
  fs.mkdirSync(path.dirname(store), { recursive: true });
  const json = JSON.stringify(acc);
  fs.writeFileSync(store, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json, { mode: 0o600 });
}

// ---- developer token: read from the music.apple.com web player, like GlassPlayer does for SoundCloud ----
let devToken = null;
async function token(refresh = false) {
  if (process.env.APPLE_MUSIC_DEVELOPER_TOKEN) return process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  if (devToken && !refresh) return devToken;
  const html = await (await fetch(WEB + "/us/browse", { headers: { "User-Agent": UA } })).text();
  const scripts = [...html.matchAll(/<script[^>]+src="(\/assets\/[^"]+\.js)"/g)].map(m => WEB + m[1]);
  for (const url of scripts) {
    try {
      const js = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
      for (const [jwt] of js.matchAll(/eyJ[\w-]{10,}\.eyJ[\w-]+\.[\w-]+/g)) {
        try { if (JSON.parse(Buffer.from(jwt.split(".")[0], "base64url")).alg === "ES256") return (devToken = jwt); } catch {}
      }
    } catch {}
  }
  throw new Error("Couldn't reach Apple Music.");
}

// ---- the UI is served from localhost, like Cider ----
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
function serve() {
  const root = path.join(__dirname, "ui");
  const server = http.createServer((req, res) => {
    const file = path.join(root, path.normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
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
    width: 1020, height: 660, minWidth: 860, minHeight: 580,
    frame: false, backgroundColor: "#121218", title: "Orchard", show: false,
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
          if (!${clicked}) { const b = [...document.querySelectorAll('button, a')].find(e => /^\\s*sign in\\s*$/i.test(e.textContent)); if (b) { b.click(); return 'clicked'; } }
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
  try { fs.unlinkSync(store); } catch {}
  await session.fromPartition("persist:apple-signin").clearStorageData();
}

ipcMain.handle("token", (_e, refresh) => token(refresh));
ipcMain.handle("account", () => loadAccount());
ipcMain.handle("lyrics-external", (_e, q) => lyricsSources.external(q));
ipcMain.handle("sign-in", () => signIn());
ipcMain.handle("sign-out", () => signOut());
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
