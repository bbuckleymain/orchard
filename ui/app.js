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
  $("vol").value = music.volume; fill($("vol"));

  music.addEventListener("playbackStateDidChange", onState);
  music.addEventListener("nowPlayingItemDidChange", onItem);
  music.addEventListener("playbackTimeDidChange", onTime);
  music.addEventListener("playbackDurationDidChange", onTime);
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
  return { kind: "song", id: s.id, lib, playId: a.playParams.id, title: a.name, artist: a.artistName, art: artwork, ms: a.durationInMillis || 0 };
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
async function open(item) {
  status("Loading…");
  try {
    let list;
    if (item.kind === "category") list = await libraryList(item.id);
    else if (item.kind === "artist") list = await artistPage(item);
    else list = await tracksOf(item);
    stack.push({ title: crumbTitle(), items, scroll: $("list").scrollTop });
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
const crumbTitle = () => currentTitle;

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
    li.style.animationDelay = `${Math.min(i, 14) * 45}ms`;
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
  status(msg ?? (list.length ? "" : view === "search" ? "No results. Try different words." : "Nothing here yet."));
}

async function load() {
  if (!music) return;
  stack = [];
  const q = $("q").value.trim();
  if (view === "search" && !q) { show([], "Search for a song or artist."); return; }
  status(view === "search" ? "Searching…" : "Loading…");
  try { show(view === "search" ? await search(q) : await tabs[view]()); }
  catch (e) { show([], (view === "search" ? "Search failed: " : "") + (e?.message || e)); }
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
  const playing = music.isPlaying;
  $("playIcon").setAttribute("d", playing ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 4v16l13-8z");
  $("play").title = playing ? "Pause" : "Play";
  $("art").classList.toggle("playing", playing);
}

function onItem() {
  const it = music.nowPlayingItem;
  if (!it) return;
  for (const el of [$("title"), $("artist")]) { el.classList.remove("fade"); void el.offsetWidth; el.classList.add("fade"); }
  $("title").textContent = it.title || it.attributes?.name || "";
  $("artist").textContent = it.artistName || it.attributes?.artistName || "";
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
  if (seeking || !dur) return;
  const s = $("seek");
  s.max = dur; s.value = music.currentPlaybackTime || 0; fill(s);
  $("cur").textContent = fmt(s.value);
  $("dur").textContent = fmt(dur);
}

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
// The <audio> element MusicKit plays through has the real position.
function playTime() {
  const a = document.getElementById("apple-music-player");
  return a && Number.isFinite(a.currentTime) && a.currentSrc ? a.currentTime : music.currentPlaybackTime || 0;
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
  const spans = [...el.querySelectorAll(":scope > .w")];
  fillWords(line.words, spans, line.end);
  if (line.bg?.length) fillWords(line.bg, [...el.querySelectorAll(".bgv .w")], line.end);
}

$("lyrics").addEventListener("wheel", () => { userScrollUntil = Date.now() + 3500; }, { passive: true });
$("lyrics").addEventListener("click", e => {
  const el = e.target.closest(".ly");
  const line = el && lyr?.synced && lyr.lines[+el.dataset.i];
  if (!line || line.rest || line.start == null) return;
  userScrollUntil = 0;
  music.seekToTime(Math.max(0, line.start - prefs.nudge + 0.01));
});

function showNudge() { $("nudgeVal").textContent = `${prefs.nudge > 0 ? "+" : ""}${prefs.nudge.toFixed(1)} s`; }
const nudge = d => { prefs.nudge = Math.round(Math.min(Math.max(prefs.nudge + d, -5), 5) * 10) / 10; savePrefs(); showNudge(); lyrIdx = -2; };
$("nudgeLess").onclick = () => nudge(-0.1);
$("nudgeMore").onclick = () => nudge(0.1);
showNudge();

// ---- queue ----
function renderQueue() {
  if (pane !== "queue" || !music) return;
  const ul = $("queue");
  const list = music.queue?.items || [];
  const pos = music.nowPlayingItemIndex ?? music.queue?.position ?? 0;
  ul.innerHTML = "";
  const head = text => { const li = document.createElement("li"); li.className = "head"; li.textContent = text; ul.appendChild(li); };
  if (!list.length) { head("The queue is empty. Play something from the list."); return; }
  list.slice(pos, pos + 300).forEach((it, k) => {
    const i = pos + k;
    if (k === 0) head("Now Playing");
    if (k === 1) head(`Up Next · ${list.length - pos - 1} song${list.length - pos - 1 === 1 ? "" : "s"}`);
    const li = document.createElement("li");
    li.dataset.i = i;
    if (i === pos) li.classList.add("on");
    li.innerHTML = `<img alt=""><div><div class="t"></div><div class="a"></div></div><div class="d"></div>`;
    li.querySelector("img").src = art(it.attributes?.artwork || it.artwork, 80);
    li.querySelector(".t").textContent = it.title || it.attributes?.name || "";
    li.querySelector(".a").textContent = it.artistName || it.attributes?.artistName || "";
    li.querySelector(".d").textContent = it.playbackDuration ? fmt(it.playbackDuration / 1000) : "";
    ul.appendChild(li);
  });
}
$("queue").addEventListener("click", e => {
  const li = e.target.closest("li[data-i]");
  if (li) music.changeToMediaAtIndex(+li.dataset.i);
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
  const r = await fetch("https://amp-api.music.apple.com" + path, {
    method,
    headers: { Authorization: "Bearer " + music.developerToken, "media-user-token": music.musicUserToken || "",
               ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + "px";
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
    if (act === "library" || act === "topl") editable = act === "topl" ? editable : null;
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
seek.addEventListener("input", () => { seeking = true; fill(seek); $("cur").textContent = fmt(seek.value); });
seek.addEventListener("change", async () => { await music?.seekToTime(+seek.value); seeking = false; });

const vol = $("vol");
vol.addEventListener("input", () => {
  fill(vol);
  if (music) music.volume = +vol.value;
  prefs.volume = +vol.value; savePrefs();
});

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
$("wordSync").checked = prefs.wordSync;
$("wordSync").onchange = e => { prefs.wordSync = e.target.checked; savePrefs(); if (pane === "lyrics") loadLyrics(true); };

document.addEventListener("keydown", e => {
  if (e.key === "Escape") { $("menu").hidden = true; if (!overlay.hidden) toggleSettings(false); else back(); }
  const typing = document.activeElement === $("q");
  if (!typing && (e.key === "l" || e.key === "y")) setPane(pane === "lyrics" ? "now" : "lyrics");
  if (!typing && e.key === "q") setPane(pane === "queue" ? "now" : "queue");
  if (e.key === "Backspace" && document.activeElement !== $("q")) back();
  if (e.code === "Space" && document.activeElement !== $("q")) { e.preventDefault(); $("play").click(); }
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => music?.play());
  navigator.mediaSession.setActionHandler("pause", () => music?.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => music?.skipToNextItem());
  navigator.mediaSession.setActionHandler("previoustrack", () => music?.skipToPreviousItem());
}
fill(seek); fill(vol);
