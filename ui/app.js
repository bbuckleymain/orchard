// Orchard player: Apple's MusicKit JS v3 does the streaming and DRM; this file is just the UI around it.
const $ = id => document.getElementById(id);

// Shuffles are drawn from the OS's cryptographic random source, not V8's xorshift128+, whose 128 bits of
// state can't reach every order of a playlist longer than ~34 songs. Replacing Math.random here, before
// musickit.js loads, covers MusicKit's own shuffle (a Fisher–Yates on Math.random) as well as ours.
const rngBuf = new Uint32Array(2);
Math.random = () => { crypto.getRandomValues(rngBuf); return (rngBuf[0] * 2 ** 21 + (rngBuf[1] >>> 11)) / 2 ** 53; };
// A uniform integer in [0, n), by rejection sampling so no value is favoured.
function randomBelow(n) {
  const limit = Math.floor(2 ** 32 / n) * n, one = new Uint32Array(1);
  do crypto.getRandomValues(one); while (one[0] >= limit);
  return one[0] % n;
}
let music = null, items = [], view = "search", seeking = false, searchType = "all";
let stack = [];   // drill-down history inside a tab: [{ title, items, scroll }]

const prefs = (() => { try { return JSON.parse(localStorage.getItem("glass.prefs")) || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem("glass.prefs", JSON.stringify(prefs)); } catch {} };
prefs.rememberVolume ??= true;
prefs.wordSync ??= true;
prefs.nudge ??= 0;

// ---- theme: Aero (the original look), Night Aero or Catppuccin; see themes.css ----
const THEMES = ["aero", "night", "catppuccin"];
function setTheme(name) {
  if (!THEMES.includes(name)) name = "aero";
  document.documentElement.dataset.theme = name;
  document.querySelectorAll("[data-theme-pick]").forEach(b => b.classList.toggle("on", b.dataset.themePick === name));
  if (prefs.theme !== name) { prefs.theme = name; savePrefs(); }
}
setTheme(prefs.theme);
document.querySelectorAll("[data-theme-pick]").forEach(b => b.onclick = () => setTheme(b.dataset.themePick));

const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const art = (a, size) => a?.url ? a.url.replace("{w}x{h}", `${size}x${size}`).replace("{f}", "jpg") : "";
const status = t => { $("status").textContent = t; };
const fill = el => el.style.setProperty("--p", `${(el.value - el.min) / ((el.max - el.min) || 1) * 100}%`);

// ---- start MusicKit (the Cider way: web player's developer token + Widevine) ----
document.addEventListener("musickitloaded", start);
if (window.MusicKit) start();

async function start() {
  if (music) return;
  try {
    music = await configure(await glass.token());
  } catch {
    try { music = await configure(await glass.token(true)); }          // token rotated
    catch (e) { status("Couldn't start Apple Music: " + (e?.message || e)); return; }
  }
  const acc = await glass.account();
  if (acc?.token) music.musicUserToken = acc.token;

  lockQuality();
  music.addEventListener("playbackBitrateDidChange", lockQuality);
  music.volume = prefs.rememberVolume && prefs.volume != null ? prefs.volume : 0.8;
  $("vol").value = music.volume; fill($("vol")); showVolume();

  music.addEventListener("playbackStateDidChange", onState);
  music.addEventListener("playbackVolumeDidChange", () => { report(); if (Math.abs(music.volume - +vol.value) > 0.005) { vol.value = music.volume; fill(vol); } showVolume(); });
  setInterval(() => { if (music.isPlaying) report(); }, 5000);   // keeps the position honest
  music.addEventListener("nowPlayingItemDidChange", onItem);
  music.addEventListener("playbackTimeDidChange", onTime);
  music.addEventListener("playbackDurationDidChange", () => { report(); onTime(); });
  music.addEventListener("authorizationStatusDidChange", refreshAccount);
  music.addEventListener("queueItemsDidChange", renderQueue);
  music.addEventListener("queuePositionDidChange", renderQueue);
  music.addEventListener("shuffleModeDidChange", modes);
  music.addEventListener("repeatModeDidChange", modes);
  modes();
  music.addEventListener("mediaPlaybackError", e => status("Playback error: " + (e?.message || e?.errorCode || "unknown")));

  refreshAccount();
  if (music.isAuthorized) { setView("home"); load(); }
  else { setView("search"); status("Search for a song or artist. Sign in (⚙) to play full songs."); $("q").focus(); }
}

function configure(developerToken) {
  return MusicKit.configure({
    developerToken,
    app: { name: "Apple Music", build: "1978.4.1", version: "1.0" },
    bitrate: MusicKit.PlaybackBitrate.HIGH,
    suppressErrorDialog: true,
  }).then(m => m || MusicKit.getInstance());
}

// MusicKit starts at 64 kbps and may switch down on its own. Keep it at 256 kbps AAC, the highest it streams.
function lockQuality() {
  if (music.bitrate !== MusicKit.PlaybackBitrate.HIGH) music.bitrate = MusicKit.PlaybackBitrate.HIGH;
}

// ---- catalog and library ----
// Songs, albums and artists from the catalog or your library, flattened into one list item shape.
function toItem(s) {
  const a = s.attributes;
  if (!a) return null; // unavailable in this storefront
  const lib = s.type.startsWith("library");
  const artwork = a.artwork || s.relationships?.catalog?.data?.[0]?.attributes?.artwork;
  if (s.type.endsWith("albums")) return { kind: "album", id: s.id, lib, title: a.name, artist: a.artistName, art: artwork };
  if (s.type.endsWith("artists"))
    return { kind: "artist", id: s.id, lib, catalogId: lib ? s.relationships?.catalog?.data?.[0]?.id : s.id, title: a.name, artist: "Artist", art: artwork };
  if (s.type.endsWith("playlists")) return { kind: "playlist", id: s.id, lib, canEdit: !!a.canEdit, title: a.name, artist: a.curatorName || "Playlist", art: artwork };
  if (s.type === "stations") return { kind: "station", id: s.id, title: a.name, artist: "Station", art: artwork };
  if (!a.playParams) return null; // not streamable here
  return { kind: "song", id: s.id, lib, playId: a.playParams.id, catalogId: a.playParams.catalogId, title: a.name, artist: a.artistName, art: artwork, ms: a.durationInMillis || 0 };
}

// Every page of a list. When Apple says how many there are, the remaining pages are fetched
// side by side (ten at a time) instead of one after another.
async function paged(path, params = {}, max = 500) {
  const first = await music.api.music(path, params);
  const page = first.data.data || [];
  const out = page.map(toItem).filter(Boolean);
  let next = first.data.next;
  const total = first.data.meta?.total;
  if (next && total && page.length && /[?&]offset=\d+/.test(next)) {
    const size = page.length, urls = [];
    for (let offset = size; offset < Math.min(total, max); offset += size) {
      let u = next.replace(/([?&]offset=)\d+/, "$1" + offset);
      if (!/[?&]limit=/.test(u)) u += `&limit=${size}`;
      urls.push(u);
    }
    // Straight to Apple, not through music.api, which is noticeably slower when many requests are in flight.
    if (total > max) out.note = `Showing the first ${max} of ${total}.`;
    for (let i = 0; i < urls.length; i += 10) {
      const pages = await Promise.all(urls.slice(i, i + 10).map(u => amp("GET", u).then(r => r?.data || [])));
      for (const p of pages) out.push(...p.map(toItem).filter(Boolean));
    }
    return out;
  }
  while (next && out.length < max) {
    const r = await music.api.music(next);
    out.push(...(r.data.data || []).map(toItem).filter(Boolean));
    next = r.data.next;
  }
  if (next) out.note = `Showing the first ${out.length}; there are more.`;
  return out;
}

function needSignIn(what) {
  if (!music.isAuthorized) throw new Error(`Sign in (⚙) to see ${what}.`);
}

async function search(term) {
  const link = term.match(/music\.apple\.com\/([a-z]{2})\/(album|playlist)\/(?:[^/]+\/)?([\w.\-]+)/i);
  if (link) {
    const song = term.match(/[?&]i=(\d+)/)?.[1];
    if (song) return (await music.api.music(`/v1/catalog/${link[1]}/songs/${song}`)).data.data.map(toItem).filter(Boolean);
    return paged(`/v1/catalog/${link[1]}/${link[2]}s/${link[3]}/tracks`, { limit: 100 });
  }
  const kinds = searchType === "all" ? ["songs", "artists", "albums", "playlists"] : [searchType];
  const r = await music.api.music("/v1/catalog/{{storefrontId}}/search", { term, types: kinds.join(","), limit: searchType === "all" ? 8 : 25 });
  const results = r.data?.results || {};
  const names = { songs: "Songs", artists: "Artists", albums: "Albums", playlists: "Playlists" };
  const out = [];
  for (const kind of kinds) {
    const found = (results[kind]?.data || []).map(toItem).filter(Boolean);
    if (!found.length) continue;
    if (kinds.length > 1) out.push({ kind: "header", title: names[kind] });
    out.push(...found);
  }
  return out;
}

// ---- your library ----
const LIBRARY = {
  playlists: { title: "Playlists", path: "/v1/me/library/playlists", params: { limit: 100 } },
  artists: { title: "Artists", path: "/v1/me/library/artists", params: { limit: 100, include: "catalog" } },
  albums: { title: "Albums", path: "/v1/me/library/albums", params: { limit: 100 } },
  songs: { title: "Songs", path: "/v1/me/library/songs", params: { limit: 100 } },
};
const libraryList = id => paged(LIBRARY[id].path, LIBRARY[id].params, id === "songs" ? 3000 : 1000);

const tabs = {
  async home() {
    needSignIn("your recommendations");
    const r = await music.api.music("/v1/me/recommendations", { limit: 12 });
    const out = [];
    for (const group of r.data?.data || []) {
      const contents = (group.relationships?.contents?.data || []).map(toItem).filter(Boolean);
      if (!contents.length) continue;
      out.push({ kind: "header", title: group.attributes?.title?.stringForDisplay || "For You" }, ...contents);
    }
    return out;
  },
  async library() {
    needSignIn("your library");
    const cats = Object.entries(LIBRARY).map(([id, c]) => ({ kind: "category", id, title: c.title, artist: "" }));
    let added = [];
    try { added = await paged("/v1/me/library/recently-added", { limit: 10 }, 30); } catch {}
    return [...cats, ...(added.length ? [{ kind: "header", title: "Recently Added" }, ...added] : [])];
  },
  async recent() {
    needSignIn("what you've played");
    const r = await music.api.music("/v1/me/recent/played/tracks", { types: "songs", limit: 30 });
    return (r.data?.data || []).map(toItem).filter(Boolean);
  },
  async albums() {
    needSignIn("your saved albums");
    return libraryList("albums");
  },
};

// An artist's page: top songs, then albums. Works from the catalog id, which library artists carry too.
async function artistPage(item) {
  const id = item.catalogId;
  if (!id) return paged(`/v1/me/library/artists/${item.id}/albums`, { limit: 100 });
  const [top, albums] = await Promise.all([
    music.api.music(`/v1/catalog/{{storefrontId}}/artists/${id}/view/top-songs`, { limit: 20 }).then(r => (r.data.data || []).map(toItem).filter(Boolean)).catch(() => []),
    paged(`/v1/catalog/{{storefrontId}}/artists/${id}/albums`, {}, 300).catch(() => []),
  ]);
  return [...(top.length ? [{ kind: "header", title: "Top Songs" }, ...top] : []),
          ...(albums.length ? [{ kind: "header", title: "Albums" }, ...albums] : [])];
}

// The songs inside an album, playlist or artist (top songs), for playing, queueing and adding to playlists.
async function tracksOf(item) {
  if (item.kind === "song") return [item];
  if (item.kind === "album")
    return paged(item.lib ? `/v1/me/library/albums/${item.id}/tracks` : `/v1/catalog/{{storefrontId}}/albums/${item.id}/tracks`, { limit: 100 });
  if (item.kind === "playlist")
    return paged(item.lib ? `/v1/me/library/playlists/${item.id}/tracks` : `/v1/catalog/{{storefrontId}}/playlists/${item.id}/tracks`, { limit: 100 }, 1000);
  if (item.kind === "artist") return (await artistPage(item)).filter(t => t.kind === "song");
  if (item.kind === "category" && item.id === "songs") return libraryList("songs");
  return [];
}

// Album or playlist -> its songs, artist -> top songs and albums, library category -> its contents.
let loadJob = 0;   // a slower, older answer must not replace a newer screen
async function open(item) {
  status("Loading…");
  const job = ++loadJob;
  try {
    let list;
    if (item.kind === "category") list = await libraryList(item.id);
    else if (item.kind === "artist") list = await artistPage(item);
    else list = await tracksOf(item);
    if (job !== loadJob) return;
    stack.push({ title: currentTitle, items, scroll: $("list").scrollTop });
    show(list, undefined, item.title);
  } catch (e) { status(e?.message || String(e)); }
}

function back() {
  const prev = stack.pop();
  if (!prev) return;
  show(prev.items, "", prev.title);
  $("list").scrollTop = prev.scroll;
}

const tabTitle = () => ({ home: "For You", search: "", recent: "", albums: "Albums", library: "Library" })[view];
let currentTitle = "";

const CAT_ICONS = {
  playlists: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 11h11M4 16h7"/><path class="fill" d="M17 9v7.2a2.5 2.5 0 1 0 2 2.4V11h2V9z"/></svg>',
  artists: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></svg>',
  albums: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><circle class="fill" cx="12" cy="12" r="1.2"/></svg>',
  songs: '<svg viewBox="0 0 24 24"><path class="fill" d="M9 18V6l11-2v12"/><circle class="fill" cx="6" cy="18" r="3"/><circle class="fill" cx="17" cy="16" r="3"/></svg>',
};

function show(list, msg, title = tabTitle()) {
  items = list;
  currentTitle = title;
  const crumb = $("crumb");
  crumb.hidden = !stack.length;
  if (stack.length) $("crumbText").textContent = stack[stack.length - 1].title || "Back";
  $("listTitle").textContent = stack.length ? title : "";
  $("listTitle").hidden = !stack.length;

  const ul = $("list");
  ul.innerHTML = "";
  list.forEach((t, i) => {
    const li = document.createElement("li");
    li.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
    li.dataset.i = i;
    if (t.kind === "header") {
      li.className = "header";
      li.textContent = t.title;
      ul.appendChild(li);
      return;
    }
    if (t.kind === "artist") li.classList.add("artist");
    if (t.kind === "category") {
      li.classList.add("category");
      li.innerHTML = `<div class="caticon">${CAT_ICONS[t.id] || ""}</div><div class="meta"><div class="t"></div><div class="a"></div></div><div class="d"></div>`;
    } else {
      li.innerHTML = `<img loading="lazy" alt=""><div class="meta"><div class="t"></div><div class="a"></div></div><div class="d"></div>`;
      const img = li.querySelector("img");
      if (t.art) img.src = art(t.art, 96); else img.classList.add("blank");
    }
    li.querySelector(".t").textContent = t.title;
    li.querySelector(".a").textContent = t.artist || "";
    li.querySelector(".d").textContent = t.kind === "song" ? (t.ms ? fmt(t.ms / 1000) : "") : t.kind === "station" ? "Radio" : "›";
    ul.appendChild(li);
  });
  ul.scrollTop = 0;
  markPlaying();
  status(msg ?? list.note ?? (list.length ? "" : view === "search" ? "No results. Try different words." : "Nothing here yet."));
}

async function load() {
  if (!music) return;
  stack = [];
  const job = ++loadJob, v = view;
  const q = $("q").value.trim();
  if (v === "search" && !q) { show([], "Search for a song or artist."); return; }
  status(v === "search" ? "Searching…" : "Loading…");
  try { const list = v === "search" ? await search(q) : await tabs[v](); if (job === loadJob) show(list); }
  catch (e) { if (job === loadJob) show([], (v === "search" ? "Search failed: " : "") + (e?.message || e)); }
}

// ---- playback ----
async function playAt(i) {
  if (!music) return;
  if (!music.isAuthorized) {
    status("Sign in to Apple Music in the window that opens…");
    if (!(await connect())) { status("Not signed in, playing a 30 second preview."); }
  }
  lockQuality();
  const songs = items.filter(t => t.kind === "song");
  queueJob++; shuffleLit = false; modes();
  try {
    await music.setQueue({ songs: songs.map(t => t.playId), startWith: songs.indexOf(items[i]), startPlaying: true });
    status("");
  } catch (e) { status("Couldn't play this track: " + (e?.message || e)); }
}

async function playStation(item) {
  if (!music.isAuthorized && !(await connect())) { status("Sign in (⚙) to play stations."); return; }
  lockQuality();
  try { await music.setQueue({ station: item.id, startPlaying: true }); status(""); }
  catch (e) { status("Couldn't start this station: " + (e?.message || e)); }
}

function onState() {
  report();
  const playing = music.isPlaying;
  $("playIcon").setAttribute("d", playing ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 4v16l13-8z");
  $("play").title = playing ? "Pause" : "Play";
  $("art").classList.toggle("playing", playing);
}

function onItem() {
  report();
  const it = music.nowPlayingItem;
  if (!it) return;
  for (const el of [$("title"), $("artist")]) { el.classList.remove("fade"); void el.offsetWidth; el.classList.add("fade"); }
  $("title").textContent = it.title || it.attributes?.name || "";
  $("artist").textContent = it.artistName || it.attributes?.artistName || "";
  document.title = $("artist").textContent ? `${$("title").textContent} — ${$("artist").textContent}` : $("title").textContent || "Orchard";
  const big = art(it.attributes?.artwork || it.artwork, 600);
  const img = $("artImg");
  img.classList.remove("on");
  if (big) { img.onload = () => img.classList.add("on"); img.src = big; $("glow").src = big; $("glow").classList.add("on"); }
  $("badge").hidden = !music.isAuthorized || it.isPreview;
  document.querySelectorAll(".miniArt").forEach(m => m.src = art(it.attributes?.artwork || it.artwork, 120));
  document.querySelectorAll(".miniTitle").forEach(m => m.textContent = $("title").textContent);
  document.querySelectorAll(".miniArtist").forEach(m => m.textContent = $("artist").textContent);
  if (pane === "lyrics") loadLyrics();
  renderQueue();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: $("title").textContent, artist: $("artist").textContent, album: it.albumName || "", artwork: big ? [{ src: big, sizes: "600x600" }] : [] });
  }
  markPlaying();
}

function onTime() {
  const dur = music.currentPlaybackDuration || 0;
  if (dur && "mediaSession" in navigator && navigator.mediaSession.setPositionState) {
    // Without this, system media controls (and scrobblers reading them) see every song as an endless stream.
    try { navigator.mediaSession.setPositionState({ duration: trackLength() || dur, position: Math.min(playTime(), trackLength() || dur), playbackRate: 1 }); } catch {}
  }
  if (seeking || !dur) return;
  const s = $("seek");
  s.max = dur; s.value = music.currentPlaybackTime || 0; fill(s);
  showTimes(+s.value, dur);
}

// The total under the seek bar, or the time left when you click it (remembered).
function showTimes(cur, dur) {
  $("cur").textContent = fmt(cur);
  $("dur").textContent = prefs.timeLeft ? "-" + fmt(dur - Math.floor(cur)) : fmt(dur);
}
$("dur").onclick = () => {
  prefs.timeLeft = !prefs.timeLeft; savePrefs();
  $("dur").title = prefs.timeLeft ? "Click to show the length" : "Click to show time left";
  showTimes(+seek.value, +seek.max || 0);
};
if (prefs.timeLeft) $("dur").title = "Click to show the length";

function markPlaying() {
  const id = music?.nowPlayingItem && String(music.nowPlayingItem.id);
  document.querySelectorAll("#list li").forEach(li => {
    const t = items[li.dataset.i];
    li.classList.toggle("on", !!id && t.kind === "song" && (t.playId === id || t.id === id));
  });
}

// ---- account ----
async function connect() {
  const acc = await glass.signIn();
  if (!acc?.token) return false;
  music.musicUserToken = acc.token;
  refreshAccount();
  return music.isAuthorized;
}

function refreshAccount() {
  if (!music) return;
  const on = music.isAuthorized;
  $("accName").textContent = on ? "Apple Music" : "Not connected";
  $("accDetail").textContent = on
    ? `Signed in${music.storefrontCountryCode ? ` (${music.storefrontCountryCode.toUpperCase()})` : ""}. Streaming High Quality, 256 kbps AAC.`
    : "Sign in with your Apple ID to play full songs. Needs an Apple Music subscription.";
  $("accAction").textContent = on ? "Sign out" : "Connect";
}

$("accAction").onclick = async () => {
  const b = $("accAction");
  b.disabled = true;
  if (music?.isAuthorized) {
    try { music.stop(); await music.unauthorize(); } catch {}
    await glass.signOut();
  } else {
    $("accDetail").textContent = "Sign in with your Apple ID in the window that opens…";
    await connect();
  }
  b.disabled = false;
  refreshAccount();
};

// ---- right pane: Now Playing / Lyrics / Queue ----
let pane = "now";
function setPane(name) {
  pane = name;
  document.querySelectorAll("[data-pane]").forEach(b => b.classList.toggle("on", b.dataset.pane === name));
  $("paneNow").hidden = name !== "now";
  $("paneLyrics").hidden = name !== "lyrics";
  $("paneQueue").hidden = name !== "queue";
  cancelAnimationFrame(raf);
  if (name === "lyrics") { loadLyrics(); lyrIdx = -2; raf = requestAnimationFrame(tick); }
  if (name === "queue") renderQueue();
}
document.querySelectorAll("[data-pane]").forEach(b => b.onclick = () => setPane(b.dataset.pane));

// ---- lyrics ----
let lyr = null, lyrFor = null, lyrIdx = -2, raf = 0, userScrollUntil = 0;

function lyricsMessage(text) {
  lyr = null;
  $("lyrics").className = "";
  $("lyrics").innerHTML = "";
  const d = document.createElement("div");
  d.className = "empty"; d.textContent = text;
  $("lyrics").appendChild(d);
}

async function loadLyrics(force) {
  const it = music?.nowPlayingItem;
  if (!it) { lyrFor = null; lyricsMessage("Play a song to see its lyrics."); $("lyricsSource").textContent = ""; return; }
  const key = it.id + (prefs.wordSync ? ":w" : ":l");
  if (lyrFor === key && !force) return;
  lyrFor = key;
  lyricsMessage("Looking for lyrics…");
  $("lyricsSource").textContent = "";
  let found = null;
  try { found = await Lyrics.find(music, it, { wordSync: prefs.wordSync }); } catch {}
  if (lyrFor !== key) return;                       // the song changed while we were looking
  if (!found?.lines?.length) { lyricsMessage("No lyrics for this song."); return; }
  lyr = found;
  renderLyrics();
}

function wordSpans(parent, words) {
  words.forEach((w, i) => {
    const span = document.createElement("span");
    span.className = "w"; span.textContent = w.text;
    parent.appendChild(span);
    if (!w.join && i < words.length - 1) parent.appendChild(document.createTextNode(" "));
  });
}

function renderLyrics() {
  const box = $("lyrics");
  box.innerHTML = "";
  box.className = lyr.synced ? "" : "plain";
  lyr.lines.forEach((line, i) => {
    const el = document.createElement("div");
    el.className = "ly" + (line.agent === "v2" ? " v2" : "") + (line.rest ? " rest" : "");
    el.dataset.i = i;
    if (line.rest) el.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>';
    else if (line.words.length) wordSpans(el, line.words);
    else el.textContent = line.text;
    if (line.bg?.length) { const bg = document.createElement("span"); bg.className = "bgv"; wordSpans(bg, line.bg); el.appendChild(bg); }
    box.appendChild(el);
  });
  const how = !lyr.synced ? "not synced" : lyr.worded && prefs.wordSync ? "word-synced" : "line-synced";
  $("lyricsSource").textContent = `${lyr.source} · ${how}`;
  lyrIdx = -2;
  box.scrollTop = 0;
}

// MusicKit's currentPlaybackTime is floored to whole seconds, far too coarse for lyrics.
// The <audio> element MusicKit plays through has the real position. When a song follows on by itself,
// MusicKit can move to another element and leave the old one sitting at the end of the last song, so
// only an element that agrees with MusicKit's own (floored) time is believed.
function playTime() {
  const coarse = music.currentPlaybackTime || 0;
  let best = null;
  for (const a of document.querySelectorAll("audio, video")) {
    if (!a.currentSrc || !Number.isFinite(a.currentTime) || Math.abs(a.currentTime - coarse) > 1.5) continue;
    if (!best || (best.paused && !a.paused)) best = a;
  }
  return best ? best.currentTime : coarse;
}

// Runs every frame while the lyrics are on screen.
function tick() {
  raf = requestAnimationFrame(tick);
  if (!lyr?.synced || !music) return;
  const t = playTime() + prefs.nudge;
  const lines = lyr.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].start != null && lines[i].start <= t + 0.05) idx = i; else break; }
  const box = $("lyrics"), els = box.children;

  if (idx !== lyrIdx) {
    lyrIdx = idx;
    for (let i = 0; i < els.length; i++) {
      const d = Math.abs(i - idx);
      els[i].classList.toggle("on", i === idx);
      els[i].classList.toggle("past", i < idx);
      els[i].style.setProperty("--blur", `${Math.min(d * 0.6, 2.4)}px`);
      els[i].style.setProperty("--op", `${Math.max(1 - d * 0.13, 0.35)}`);
      if (i !== idx) els[i].querySelectorAll(".w").forEach(w => { w.style.removeProperty("--p"); w.classList.remove("sung"); });
    }
    const cur = els[Math.max(idx, 0)];
    if (cur && Date.now() > userScrollUntil)
      box.scrollTo({ top: cur.offsetTop - box.clientHeight * 0.36, behavior: "smooth" });
  }

  const line = lines[idx], el = els[idx];
  if (!line || !el) return;
  if (line.rest) {                                   // three dots that fill in through the break
    const g = Math.min(Math.max((t - line.rest[0]) / (line.rest[1] - line.rest[0]), 0), 1);
    el.querySelectorAll(".dots i").forEach((dot, k) => dot.style.setProperty("--g", Math.min(Math.max(g * 3 - k, 0), 1)));
    return;
  }
  if (!prefs.wordSync) return;
  const fillWords = (words, spans, lineEnd) => words.forEach((w, k) => {
    const end = w.end ?? words[k + 1]?.start ?? lineEnd ?? w.start + 0.55;
    const p = Math.min(Math.max((t - w.start) / Math.max(end - w.start, 0.05), 0), 1) * 100;
    spans[k]?.style.setProperty("--p", p.toFixed(1));
    spans[k]?.classList.toggle("sung", p > 0);
  });
  el._spans ??= [...el.querySelectorAll(":scope > .w")];
  fillWords(line.words, el._spans, line.end);
  if (line.bg?.length) fillWords(line.bg, el._bgSpans ??= [...el.querySelectorAll(".bgv .w")], line.end);
}

$("lyrics").addEventListener("wheel", () => { userScrollUntil = Date.now() + 3500; }, { passive: true });
$("lyrics").addEventListener("click", e => {
  const el = e.target.closest(".ly");
  const line = el && lyr?.synced && lyr.lines[+el.dataset.i];
  if (!line || line.rest || line.start == null) return;
  userScrollUntil = 0;
  music.seekToTime(Math.max(0, line.start - prefs.nudge + 0.01)).then(() => report({ seeked: true }));
});

function showNudge() { $("nudgeVal").textContent = `${prefs.nudge > 0 ? "+" : ""}${prefs.nudge.toFixed(1)} s`; }
const nudge = d => { prefs.nudge = Math.round(Math.min(Math.max(prefs.nudge + d, -5), 5) * 10) / 10; savePrefs(); showNudge(); lyrIdx = -2; };
$("nudgeLess").onclick = () => nudge(-0.1);
$("nudgeMore").onclick = () => nudge(0.1);
showNudge();

// ---- queue ----
// Up Next can be rearranged by dragging, a song removed with its × (or the right-click menu), and the lot
// cleared with Clear (click twice). The song that's playing is never touched, so playback carries on.
let clearArmed = 0, clearTimer = 0, dragFrom = -1;
function renderQueue() {
  if (pane !== "queue" || !music || dragFrom >= 0) return;   // redrawn when the drag ends
  const ul = $("queue");
  const list = music.queue?.items || [];
  const pos = music.nowPlayingItemIndex ?? music.queue?.position ?? 0;
  ul.innerHTML = "";
  const head = text => { const li = document.createElement("li"); li.className = "head"; li.textContent = text; ul.appendChild(li); return li; };
  if (!list.length) { head("The queue is empty. Play something from the list."); return; }
  list.slice(pos, pos + 300).forEach((it, k) => {
    const i = pos + k;
    if (k === 0) head("Now Playing");
    if (k === 1) {
      const n = list.length - pos - 1, h = head(`Up Next · ${n} song${n === 1 ? "" : "s"}`);
      const b = document.createElement("button");
      b.className = "clear" + (clearArmed > Date.now() ? " armed" : "");
      b.textContent = clearArmed > Date.now() ? "Clear all?" : "Clear";
      b.title = "Remove every song after this one";
      h.appendChild(b);
    }
    const li = document.createElement("li");
    li.dataset.i = i;
    li.dataset.id = it.id;
    if (i === pos) li.classList.add("on");
    else li.draggable = true;
    li.innerHTML = `<img alt=""><div><div class="t"></div><div class="a"></div></div><div class="d"></div>`;
    li.querySelector("img").src = art(it.attributes?.artwork || it.artwork, 80);
    li.querySelector(".t").textContent = it.title || it.attributes?.name || "";
    li.querySelector(".a").textContent = it.artistName || it.attributes?.artistName || "";
    li.querySelector(".d").textContent = it.playbackDuration ? fmt(it.playbackDuration / 1000) : "";
    if (i !== pos) li.insertAdjacentHTML("beforeend", `<button class="x" title="Remove from Queue"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`);
    ul.appendChild(li);
  });
}

// One edit at a time, each against the queue as it is by then.
let queueEdits = Promise.resolve();
function editQueue(plan, check, done) {
  queueEdits = queueEdits.then(async () => {
    if (!music) return;
    try { if (await QueueEdit.apply(music, plan, check) && done) status(done); }
    catch (e) { status("Couldn't change the queue: " + (e?.message || e)); }
    renderQueue();
  });
  return queueEdits;
}
const queuePos = () => music.nowPlayingItemIndex ?? music.queue?.position ?? 0;
const queueRow = li => [+li.dataset.i, li.dataset.id];
const removeQueued = li => editQueue((n, pos) => QueueEdit.remove(n, pos, +li.dataset.i), queueRow(li), "Removed from the queue");
const moveQueued = (li, to) => editQueue((n, pos) => QueueEdit.move(n, pos, +li.dataset.i, typeof to === "function" ? to(n, pos) : to), queueRow(li));
function clearQueue() {
  clearArmed = 0; clearTimeout(clearTimer);
  queueJob++;   // stop a long list that's still being added in the background
  editQueue((n, pos) => QueueEdit.clear(n, pos), null, "Cleared Up Next");
}

$("queue").addEventListener("click", e => {
  if (e.target.closest(".clear")) {
    if (clearArmed > Date.now()) { clearQueue(); return; }
    clearArmed = Date.now() + 3000;
    clearTimeout(clearTimer); clearTimer = setTimeout(() => { clearArmed = 0; renderQueue(); }, 3000);
    renderQueue();
    return;
  }
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  if (e.target.closest(".x")) { removeQueued(li); return; }
  music.changeToMediaAtIndex(+li.dataset.i);
});

// drag and drop within Up Next
const dropMarks = () => document.querySelectorAll("#queue .drop-before, #queue .drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"));
$("queue").addEventListener("dragstart", e => {
  const li = e.target.closest("li[data-i]");
  if (!li || !li.draggable) return;
  dragFrom = +li.dataset.i;
  li.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", li.dataset.id || "");
});
$("queue").addEventListener("dragover", e => {
  const li = e.target.closest("li[data-i]");
  if (dragFrom < 0 || !li) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const r = li.getBoundingClientRect(), after = li.classList.contains("on") || e.clientY > r.top + r.height / 2;
  dropMarks();
  li.classList.add(after ? "drop-after" : "drop-before");
});
$("queue").addEventListener("drop", e => {
  const li = e.target.closest("li[data-i]"), from = $("queue").querySelector(`li[data-i="${dragFrom}"]`);
  dropMarks();
  if (dragFrom < 0 || !li || !from) return;
  e.preventDefault();
  const target = +li.dataset.i, after = li.classList.contains("on") || e.clientY > li.getBoundingClientRect().top + li.getBoundingClientRect().height / 2;
  dragFrom = -1;   // so the edit's redraw isn't held back
  moveQueued(from, (n, pos) => QueueEdit.dropIndex(pos, +from.dataset.i, target, after));
});
$("queue").addEventListener("dragend", () => {
  dragFrom = -1; dropMarks();
  renderQueue();
});

// right-click a queued song
$("queue").addEventListener("contextmenu", e => {
  const li = e.target.closest("li[data-i]");
  if (!li || !music) return;
  e.preventDefault();
  const i = +li.dataset.i, pos = queuePos(), last = (music.queue?.items?.length || 0) - 1;
  menuItem = { kind: "queued", li };
  fillMenu(i === pos ? [["qplay", "Play from Start"]] : [
    ["qplay", "Play Now"], "-",
    i > pos + 1 && ["qtop", "Move to Top"], i > pos + 1 && ["qup", "Move Up"],
    i < last && ["qdown", "Move Down"], i < last && ["qbottom", "Move to Bottom"], "-",
    ["qremove", "Remove from Queue"],
  ]);
  placeMenu(e.clientX, e.clientY);
});

let shuffleLit = false;   // on after we shuffled a list ourselves, even though MusicKit's own mode is off
function modes() {
  if (!music) return;
  $("shuffle").classList.toggle("on", !!music.shuffleMode || shuffleLit);
  $("repeat").classList.toggle("on", music.repeatMode !== 0);
  $("repeat").classList.toggle("one", music.repeatMode === 1);
  $("repeat").title = ["Repeat", "Repeat one", "Repeat all"][music.repeatMode] || "Repeat";
}
$("shuffle").onclick = async () => {
  if (!music) return;
  const songs = items.filter(t => t.kind === "song");
  if (!music.nowPlayingItem && songs.length) {          // nothing playing: shuffle what's on screen
    try { await startList(shuffled(songs)); shuffleLit = true; modes(); status(`Shuffling ${songs.length} songs`); }
    catch (e) { status("Couldn't shuffle: " + (e?.message || e)); }
    return;
  }
  const on = !(music.shuffleMode || shuffleLit);
  shuffleLit = false;
  music.shuffleMode = on ? 1 : 0;   // MusicKit shuffles what's after the current song (crypto-random, see top)
  modes(); renderQueue();
};
$("repeat").onclick = () => { if (music) { music.repeatMode = { 0: 2, 2: 1, 1: 0 }[music.repeatMode]; modes(); } };

// ---- right-click menu ----
async function amp(method, path, body) {
  const send = () => fetch("https://amp-api.music.apple.com" + path, {
    method,
    headers: { Authorization: "Bearer " + music.developerToken, "media-user-token": music.musicUserToken || "",
               ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await send();
  for (let wait = 1; r.status === 429 && wait <= 16; wait *= 2) {   // asked too fast: wait, then try again
    await new Promise(done => setTimeout(done, (+r.headers.get("retry-after") || wait) * 1000));
    r = await send();
  }
  if (!r.ok) throw new Error(`Apple Music answered ${r.status}`);
  return r.status === 200 || r.status === 201 ? r.json().catch(() => null) : null;
}

// Fisher–Yates: every order equally likely.
const shuffled = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = randomBelow(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Queue a list and start it. Long lists start after the first 100 songs and the rest are added
// behind them in the background, so a big shuffle plays in a second or two instead of after all of it loads.
const FIRST = 100;
let queueJob = 0;
async function startList(songs) {
  const ids = songs.map(t => t.playId), job = ++queueJob;
  lockQuality();
  await music.setQueue({ songs: ids.slice(0, FIRST), startPlaying: true });
  (async () => {
    for (let i = FIRST; i < ids.length && job === queueJob; i += FIRST) {
      try { await music.playLater({ songs: ids.slice(i, i + FIRST) }); } catch { break; }
      renderQueue();
    }
  })();
}

const ACTIONS = {
  async play(item) {
    status(`Loading ${item.title}…`);
    const songs = await tracksOf(item);
    if (!songs.length) throw new Error("nothing playable here");
    music.shuffleMode = 0;
    await startList(songs);
    return `Playing ${item.title} · ${songs.length} song${songs.length === 1 ? "" : "s"}`;
  },
  async shuffle(item) {
    status(`Shuffling ${item.title}…`);
    const songs = await tracksOf(item);
    if (!songs.length) throw new Error("nothing playable here");
    music.shuffleMode = 0;
    // The whole list is shuffled here (uniformly, see shuffled()), so the order is already random;
    // the Shuffle button is lit to say so, without asking MusicKit to shuffle it again.
    await startList(shuffled(songs));
    shuffleLit = true; modes();
    return `Shuffling ${item.title} · ${songs.length} song${songs.length === 1 ? "" : "s"}`;
  },
  async next(item) {
    const songs = await tracksOf(item);
    if (!music.nowPlayingItem) await music.setQueue({ songs: songs.map(t => t.playId), startPlaying: true });
    else await music.playNext({ songs: songs.map(t => t.playId) });
    return `Playing next: ${item.title}`;
  },
  async later(item) {
    const songs = await tracksOf(item);
    if (!music.nowPlayingItem) await music.setQueue({ songs: songs.map(t => t.playId), startPlaying: true });
    else await music.playLater({ songs: songs.map(t => t.playId) });
    return `Added to queue: ${item.title}`;
  },
  async library(item) {
    const id = item.kind === "song" ? item.playId : item.id;
    await amp("POST", `/v1/me/library?ids%5B${item.kind}s%5D=${encodeURIComponent(id)}`);
    return `Added to your library: ${item.title}`;
  },
  async open(item) { await open(item); return ""; },
  // songs in the queue (right-click in the Queue pane)
  async qplay({ li }) { +li.dataset.i === queuePos() ? await music.seekToTime(0) : await music.changeToMediaAtIndex(+li.dataset.i); return ""; },
  async qtop({ li }) { await moveQueued(li, (n, pos) => pos + 1); return ""; },
  async qup({ li }) { await moveQueued(li, +li.dataset.i - 1); return ""; },
  async qdown({ li }) { await moveQueued(li, +li.dataset.i + 1); return ""; },
  async qbottom({ li }) { await moveQueued(li, n => n - 1); return ""; },
  async qremove({ li }) { await removeQueued(li); return ""; },
};

async function addToPlaylist(item, playlist) {
  const songs = await tracksOf(item);
  await amp("POST", `/v1/me/library/playlists/${playlist.id}/tracks`,
            { data: songs.map(t => ({ id: t.playId, type: t.lib || String(t.playId).startsWith("i.") ? "library-songs" : "songs" })) });
  return `Added ${item.title} to ${playlist.title}`;
}

function menuEntries(item) {
  const signedIn = music?.isAuthorized;
  const canAdd = signedIn && !item.lib && ["song", "album", "playlist"].includes(item.kind);
  switch (item.kind) {
    case "song": return [["play", "Play"], ["next", "Play Next"], ["later", "Add to Queue"], "-",
                         canAdd && ["library", "Add to Library"], signedIn && ["playlist", "Add to Playlist…"]];
    case "album":
    case "playlist": return [["play", "Play"], ["shuffle", "Shuffle"], ["next", "Play Next"], ["later", "Add to Queue"], "-",
                             canAdd && ["library", "Add to Library"], signedIn && ["playlist", "Add to Playlist…"]];
    case "artist": return [["open", "Go to Artist"], "-", ["play", "Play Top Songs"], ["shuffle", "Shuffle Top Songs"]];
    case "category": return item.id === "songs" ? [["shuffle", "Shuffle All"], ["play", "Play All"]] : [];
    default: return [];
  }
}

let menuItem = null;
function fillMenu(entries) {
  const m = $("menu");
  m.innerHTML = "";
  entries.filter(Boolean).forEach(e => {
    if (e === "-") { if (m.lastChild && m.lastChild.tagName !== "HR") m.appendChild(document.createElement("hr")); return; }
    const b = document.createElement("button");
    b.dataset.act = e[0]; b.textContent = e[1];
    if (e[2]) b.dataset.pl = e[2];
    m.appendChild(b);
  });
  if (m.lastChild?.tagName === "HR") m.lastChild.remove();
}
function placeMenu(x, y) {
  const m = $("menu");
  m.hidden = false;
  const left = Math.min(x, innerWidth - m.offsetWidth - 8), top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8));
  m.style.left = left + "px";
  m.style.top = top + "px";
  // grow out of the pointer, from whichever corner the menu was pushed to
  m.style.transformOrigin = `${left < x ? "right" : "left"} ${top < y ? "bottom" : "top"}`;
}

$("list").addEventListener("contextmenu", e => {
  const li = e.target.closest("li[data-i]");
  const item = li && items[+li.dataset.i];
  const entries = item ? menuEntries(item) : [];
  if (!entries.filter(x => x && x !== "-").length) return;
  e.preventDefault();
  menuItem = item;
  fillMenu(entries);
  placeMenu(e.clientX, e.clientY);
});
document.addEventListener("click", () => { $("menu").hidden = true; });

let editable = null;   // your playlists that can take songs, fetched once
$("menu").addEventListener("click", async e => {
  const b = e.target.closest("button");
  if (!b || !menuItem || !music) return;
  const item = menuItem, act = b.dataset.act;
  if (act === "playlist") {                        // swap the menu for a list of your playlists
    e.stopPropagation();
    const m = $("menu"), at = m.getBoundingClientRect();
    fillMenu([["back", "‹ Back"], "-", ["none", "Loading playlists…"]]);
    try { editable ??= (await libraryList("playlists")).filter(p => p.canEdit); } catch { editable = []; }
    if (m.hidden || menuItem !== item) return;
    fillMenu([["back", "‹ Back"], "-", ...(editable.length ? editable.map(p => ["topl", p.title, p.id]) : [["none", "No playlists you can edit"]])]);
    placeMenu(at.left, at.top);
    return;
  }
  if (act === "back") { e.stopPropagation(); fillMenu(menuEntries(item)); return; }
  if (act === "none") { e.stopPropagation(); return; }
  try {
    if (act === "open" || act === "library" || act === "topl") status("Working…");
    const msg = act === "topl" ? await addToPlaylist(item, editable.find(p => p.id === b.dataset.pl)) : await ACTIONS[act](item);
    if (msg) status(msg);
  } catch (err) { status("Couldn't do that: " + (err?.message || err)); }
  renderQueue();
});

// ---- controls ----
$("q").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (view !== "search") setView("search");
  load();
});
$("list").addEventListener("click", e => {
  const li = e.target.closest("li");
  if (!li) return;
  const item = items[+li.dataset.i];
  if (item.kind === "header") return;
  if (item.kind === "song") playAt(+li.dataset.i);
  else if (item.kind === "station") playStation(item);
  else open(item);
});
$("crumb").onclick = back;
document.querySelectorAll("#filters [data-type]").forEach(b => b.onclick = () => {
  searchType = b.dataset.type;
  document.querySelectorAll("#filters [data-type]").forEach(x => x.classList.toggle("on", x === b));
  if ($("q").value.trim()) load();
});
$("play").onclick = () => {
  if (!music?.nowPlayingItem) { const i = items.findIndex(t => t.kind === "song"); if (i >= 0) playAt(i); return; }
  music.isPlaying ? music.pause() : music.play();
};
$("next").onclick = () => music?.skipToNextItem();
$("prev").onclick = () => music && (music.currentPlaybackTime > 3 ? music.seekToTime(0) : music.skipToPreviousItem());

const seek = $("seek");
seek.addEventListener("input", () => { seeking = true; fill(seek); showTimes(+seek.value, +seek.max || 0); });
// Hovering the seek bar shows the time you'd jump to.
seek.addEventListener("mousemove", e => {
  const r = seek.getBoundingClientRect(), x = Math.min(Math.max(e.clientX - r.left, 0), r.width), tip = $("seekTip");
  const dur = music?.currentPlaybackDuration || 0;
  tip.classList.toggle("on", dur > 0);
  if (!dur) return;
  tip.textContent = fmt(x / r.width * dur);
  seek.parentElement.style.setProperty("--hover-x", x + "px");
});
seek.addEventListener("change", async () => { await music?.seekToTime(+seek.value); seeking = false; report({ seeked: true }); });

const vol = $("vol");
// Volume from the slider, the wheel, the keyboard or the mute button. Muting isn't remembered as the
// volume, so the next launch doesn't start silent; unmuting goes back to where it was.
let unmuted = null;
function setVolume(v) {
  v = Math.round(Math.min(Math.max(v, 0), 1) * 100) / 100;
  vol.value = v; fill(vol);
  if (music) music.volume = v;
  if (v > 0) { unmuted = null; prefs.volume = v; savePrefs(); }
  showVolume();
}
function showVolume() {
  const muted = +vol.value === 0;
  $("volIcon").classList.toggle("muted", muted);
  $("volIcon").title = muted ? "Unmute (M)" : "Mute (M)";
}
function toggleMute() {
  if (+vol.value > 0) { unmuted = +vol.value; vol.value = 0; fill(vol); if (music) music.volume = 0; showVolume(); }
  else setVolume(unmuted || prefs.volume || 0.8);
}
vol.addEventListener("input", () => setVolume(+vol.value));
$("volIcon").onclick = toggleMute;
$("volIcon").parentElement.addEventListener("wheel", e => { e.preventDefault(); setVolume(+vol.value - Math.sign(e.deltaY) * 0.05); }, { passive: false });

document.querySelectorAll("[data-win]").forEach(b => b.onclick = () => glass.window(b.dataset.win));

function setView(v) {
  view = v;
  $("filters").hidden = v !== "search";
  document.querySelectorAll(".pill[data-view]").forEach(p => p.classList.toggle("on", p.dataset.view === v));
}
document.querySelectorAll(".pill[data-view]").forEach(p => p.onclick = () => {
  setView(p.dataset.view);
  if (view === "search") $("q").focus();
  load();
});

// settings sheet
const overlay = $("overlay");
const toggleSettings = open => { overlay.hidden = !open; if (open) refreshAccount(); };
$("settingsBtn").onclick = () => toggleSettings(overlay.hidden);
$("closeSettings").onclick = $("dim").onclick = () => toggleSettings(false);
$("rememberVol").checked = prefs.rememberVolume;
$("rememberVol").onchange = e => { prefs.rememberVolume = e.target.checked; savePrefs(); };
async function showMxm(st) {
  st ??= await glass.musixmatchStatus();
  $("mxmStatus").textContent = !st.hasKey ? "No key: using Apple Music, NetEase and LRCLIB." : st.status ? "Musixmatch: " + st.status : "Key saved. Musixmatch is asked first.";
}
$("mxmSave").onclick = async () => { const st = await glass.setMusixmatchKey($("mxmKey").value); $("mxmKey").value = ""; showMxm(st); };
showMxm();

// ---- favourite your most-played Last.fm songs (the matching happens in the main process, see lastfm.js) ----
let lfm = null;   // what the last Preview found and still has to add
const lfmNote = text => { $("lfmStatus").textContent = text; };
const lfmError = e => lfmNote("Couldn't do that: " + String(e?.message || e).replace(/^.*Error: /, ""));
glass.lastfmStatus().then(has => { if (has) $("lfmKey").placeholder = "Key saved. Paste a new one to replace it"; });
$("lfmKeySave").onclick = async () => { const has = await glass.setLastfmKey($("lfmKey").value); $("lfmKey").value = ""; lfmNote(has ? "Last.fm key saved." : "Last.fm key removed."); };
$("lfmUser").value = prefs.lastfmUser || "";

// Songs you've already favourited are left out, so running this twice adds nothing the second time.
async function notFavourited(songs) {
  const done = new Set();
  for (let i = 0; i < songs.length; i += 50) {
    const r = await amp("GET", `/v1/me/ratings/songs?ids=${songs.slice(i, i + 50).map(s => s.id).join(",")}`);
    for (const x of r?.data || []) if (x.attributes?.value === 1) done.add(x.id);
  }
  return songs.filter(s => !done.has(s.id));
}

// Removing your current favourites (run this before Preview). Apple has no "list my favourites" call, so every library
// song is checked, by its library id and by its catalog id. A favourite on a song that isn't in your library isn't found.
async function currentFavourites() {
  const songs = await paged("/v1/me/library/songs", { limit: 100, include: "catalog" }, 20000);
  const found = [];
  for (const [kind, path, ids] of [["library-songs", "library-songs", songs.map(s => s.id)],
                                    ["songs", "songs", [...new Set(songs.map(s => s.catalogId).filter(Boolean))]]]) {
    for (let i = 0; i < ids.length; i += 50) {
      const r = await amp("GET", `/v1/me/ratings/${path}?ids=${ids.slice(i, i + 50).join(",")}`);
      for (const x of r?.data || []) if (x.attributes?.value === 1) found.push({ path: kind, id: x.id });
    }
  }
  return found;
}

let clearFavs = null, clearFavsTimer = 0;
$("lfmClear").onclick = async () => {
  const b = $("lfmClear");
  if (!music?.isAuthorized) { lfmNote("Sign in to Apple Music first (Account, above)."); return; }
  if (clearFavs) {                                   // second click: do it
    const todo = clearFavs; clearFavs = null; clearTimeout(clearFavsTimer);
    b.disabled = true;
    try {
      for (const [n, f] of todo.entries()) { await amp("DELETE", `/v1/me/ratings/${f.path}/${f.id}`); if (n % 10 === 9) lfmNote(`Removed ${n + 1} of ${todo.length}…`); }
      lfmNote(`Removed ${todo.length} favourites. Run Preview next.`);
    } catch (e) { lfmError(e); }
    b.disabled = false; b.textContent = "Remove my current favourites…";
    return;
  }
  b.disabled = true; lfmNote("Looking through your library for favourites…");
  try {
    const found = await currentFavourites();
    if (!found.length) { lfmNote("No current favourites found in your library."); b.textContent = "Remove my current favourites…"; }
    else {
      clearFavs = found;
      b.textContent = `Click again to remove ${found.length} favourites for good`;
      lfmNote(`Found ${found.length} favourites. Removing them can't be undone. Click the button again within 10 seconds, or ignore it to cancel.`);
      clearFavsTimer = setTimeout(() => { clearFavs = null; b.textContent = "Remove my current favourites…"; lfmNote("Cancelled. Nothing was removed."); }, 10000);
    }
  } catch (e) { lfmError(e); }
  b.disabled = false;
};

$("lfmPreview").onclick = async () => {
  if (!music?.isAuthorized) { lfmNote("Sign in to Apple Music first (Account, above)."); return; }
  lfm = null; $("lfmTest").disabled = $("lfmAdd").disabled = true;
  prefs.lastfmUser = $("lfmUser").value.trim(); savePrefs();
  lfmNote("Reading Last.fm and finding the songs on Apple Music…");
  try {
    const min = +$("lfmMin").value || 10;
    const r = await glass.lastfmMatch({ user: $("lfmUser").value, min });
    const fresh = await notFavourited(r.matched);
    lfm = { fresh };
    $("lfmMissing").textContent = r.unmatched.map(t => `${t.artist} – ${t.title} (${t.plays})`).join("\n");
    lfmNote(`${r.total} songs with ${min}+ plays: ${r.matched.length} found on Apple Music (${r.matched.length - fresh.length} already favourites), ${r.unmatched.length} not found. ${fresh.length} to add.`);
    $("lfmTest").disabled = $("lfmAdd").disabled = !fresh.length;
  } catch (e) { lfmError(e); }
};

async function addFavourites(songs) {
  $("lfmTest").disabled = $("lfmAdd").disabled = true;
  try {
    for (const [n, s] of songs.entries()) {
      await amp("PUT", `/v1/me/ratings/songs/${s.id}`, { type: "rating", attributes: { value: 1 } });
      lfm.fresh = lfm.fresh.filter(x => x !== s);
      lfmNote(`Favourited ${n + 1} of ${songs.length}…`);
    }
    lfmNote(`Favourited ${songs.length}: ${songs.slice(0, 3).map(s => `${s.artist} – ${s.title}`).join("; ")}${songs.length > 3 ? "…" : ""}. ${lfm.fresh.length} left.`);
  } catch (e) { lfmError(e); }
  $("lfmTest").disabled = $("lfmAdd").disabled = !lfm.fresh.length;
}
$("lfmTest").onclick = () => lfm && addFavourites(lfm.fresh.slice(0, 3));
$("lfmAdd").onclick = () => lfm && addFavourites([...lfm.fresh]);

$("wordSync").checked = prefs.wordSync;
$("wordSync").onchange = e => { prefs.wordSync = e.target.checked; savePrefs(); if (pane === "lyrics") loadLyrics(true); };

document.addEventListener("keydown", e => {
  const el = document.activeElement;
  // Any text box counts (the search, the Musixmatch key), so typing there never fires a shortcut.
  const typing = !!el && (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["range", "checkbox"].includes(el.type)));
  const slider = el?.type === "range";   // sliders take the arrow keys themselves
  if (e.key === "Escape") {
    $("menu").hidden = true;
    if (typing) el.blur(); else if (!overlay.hidden) toggleSettings(false); else back();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); toggleSettings(false); $("q").focus(); $("q").select(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case "/": e.preventDefault(); toggleSettings(false); $("q").focus(); $("q").select(); break;
    case "l": case "y": setPane(pane === "lyrics" ? "now" : "lyrics"); break;
    case "q": setPane(pane === "queue" ? "now" : "queue"); break;
    case "m": toggleMute(); break;
    case "Backspace": back(); break;
    case " ": e.preventDefault(); $("play").click(); break;
    case "ArrowLeft": case "ArrowRight": {
      if (slider || !music?.nowPlayingItem) return;
      e.preventDefault();
      const d = key === "ArrowRight" ? 1 : -1;
      if (e.shiftKey) { d > 0 ? $("next").click() : music.skipToPreviousItem(); return; }
      const t = Math.min(Math.max((music.currentPlaybackTime || 0) + d * 5, 0), Math.max((music.currentPlaybackDuration || 0) - 1, 0));
      music.seekToTime(t).then(() => report({ seeked: true }));
      break;
    }
    case "ArrowUp": case "ArrowDown":
      if (slider || el?.closest?.("#list, #queue, #lyrics, #sheet, #menu")) return;   // let lists scroll
      e.preventDefault();
      setVolume(+vol.value + (key === "ArrowUp" ? 0.05 : -0.05));
      break;
  }
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => music?.play());
  navigator.mediaSession.setActionHandler("pause", () => music?.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => music?.skipToNextItem());
  navigator.mediaSession.setActionHandler("previoustrack", () => music?.skipToPreviousItem());
}
// ---- what's playing, for the desktop (MPRIS on Linux: media keys, the panel, scrobblers) ----
function trackLength() {
  const it = music?.nowPlayingItem;
  return (it?.playbackDuration || it?.attributes?.durationInMillis || 0) / 1000 || music?.currentPlaybackDuration || 0;
}

function report(extra = {}) {
  if (!music) return;
  const it = music.nowPlayingItem;
  glass.mprisState({
    status: it ? (music.isPlaying ? "Playing" : "Paused") : "Stopped",
    position: playTime(),
    volume: music.volume,
    track: it ? {
      id: it.id,
      title: it.title || it.attributes?.name || "",
      artist: it.artistName || it.attributes?.artistName || "",
      album: it.albumName || it.attributes?.albumName || "",
      length: trackLength(),
      trackNumber: it.trackNumber || it.attributes?.trackNumber || 0,
      art: art(it.attributes?.artwork || it.artwork, 600),
      url: it.attributes?.url || "",
    } : null,
    ...extra,
  });
}

glass.onMpris(async ({ action, value }) => {
  if (!music) return;
  switch (action) {
    case "play": await music.play(); break;
    case "pause": await music.pause(); break;
    case "playpause": music.isPlaying ? await music.pause() : await music.play(); break;
    case "next": await music.skipToNextItem(); break;
    case "previous": $("prev").click(); break;
    case "seek": await music.seekToTime(Math.max(0, value)); report({ seeked: true }); return;
    case "seekby": await music.seekToTime(Math.max(0, playTime() + value)); report({ seeked: true }); return;
    case "volume": setVolume(value); break;
  }
  report();
});

fill(seek); fill(vol);
