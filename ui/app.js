// Orchard player. Apple's MusicKit JS v3 does the streaming and the DRM; local files play through the
// hidden <audio> element. This file is the interface around those two, and the one place that decides
// which of them is playing.
const $ = id => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
// Fisher–Yates: every order equally likely.
const shuffled = list => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = randomBelow(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// ---- preferences ------------------------------------------------------------------------------
const prefs = (() => { try { return JSON.parse(localStorage.getItem("glass.prefs")) || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem("glass.prefs", JSON.stringify(prefs)); } catch {} };
prefs.rememberVolume ??= true;
prefs.wordSync ??= true;
prefs.nudge ??= 0;
prefs.layout ??= "grid";
prefs.autoSuggestedPlaylist ??= true;
prefs.eq ??= { on: false, preset: "flat", bands: [0, 0, 0, 0, 0] };
if (prefs.theme === "catppuccin") prefs.theme = "night";   // the old third theme became Night

// ---- small helpers ----------------------------------------------------------------------------
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const art = (a, size) => a?.url ? a.url.replace("{w}x{h}", `${size}x${size}`).replace("{f}", "jpg") : "";
const itemArt = (item, size) => item?.local ? (item.art || "") : art(item?.art, size);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;

let statusTimer = 0;
function status(text, error) {
  const el = $("status");
  el.textContent = text || "";
  el.classList.toggle("error", !!error && !!text);
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { el.textContent = ""; el.classList.remove("error"); }, error ? 12000 : 4200);
}

// ---- state ------------------------------------------------------------------------------------
let music = null;
let items = [];              // what the current view is showing
let view = "home";
let currentTitle = "";
let stack = [];              // drill-down history inside a tab: [{ title, items, scroll }]
let loadJob = 0;             // a slower, older answer must not replace a newer screen
let pane = "queue";
let raf = 0;
let seeking = false;

// local playback
const localAudio = $("localAudio");
let localQueue = [];         // local tracks in play order
let localIndex = -1;
let localMode = false;       // true while a local file is the current source
let localShuffle = false;
let localRepeat = 0;         // 0 off, 1 one, 2 all

// the window's colour, taken from the cover
let palette = { h: 288, s: 42, l: 56 };
let artUrl = "";
let bgOn = "A";

// ---- theme: Glass (light) and Night (dark); see themes.css -------------------------------------
const THEMES = ["aero", "night"];
function setTheme(name) {
  if (!THEMES.includes(name)) name = "aero";
  document.documentElement.dataset.theme = name;
  $$("[data-theme-pick]").forEach(b => b.classList.toggle("on", b.dataset.themePick === name));
  if (prefs.theme !== name) { prefs.theme = name; savePrefs(); }
  paintPalette();
  paintBackdrop(artUrl);
}
setTheme(prefs.theme);
$$("[data-theme-pick]").forEach(b => b.onclick = () => setTheme(b.dataset.themePick));

// ---- the light in the room --------------------------------------------------------------------
const artCanvas = document.createElement("canvas");
artCanvas.width = artCanvas.height = 20;
const artCtx = artCanvas.getContext("2d", { willReadFrequently: true });

function rgbToHsl(R, G, B) {
  R /= 255; G /= 255; B /= 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2;
  if (mx === mn) return { h: 0, s: 0, l: l * 100 };
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (mx === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

// One colour for the accent: the most saturated part of the cover, nudged towards the middle so a
// near-black or near-white sleeve still gives something usable.
function readPalette(data) {
  let r = 0, g = 0, b = 0, n = 0, vivid = null, best = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 160) continue;
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r += R; g += G; b += B; n++;
    const mx = Math.max(R, G, B), chroma = mx - Math.min(R, G, B);
    const weight = chroma * (0.45 + mx / 255);
    if (weight > best) { best = weight; vivid = [R, G, B]; }
  }
  if (!n) return { h: 288, s: 42, l: 56 };
  const [R, G, B] = best > 14 ? vivid : [r / n, g / n, b / n];
  const { h, s, l } = rgbToHsl(R, G, B);
  return { h, s: clamp(s * 1.15, 16, 78), l: clamp(l, 24, 72) };
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function relativeLuminance(rgb) {
  const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function paintPalette() {
  const night = document.documentElement.dataset.theme === "night";
  const { h, s, l } = palette;
  const root = document.documentElement.style;
  const accentS = clamp(s, 34, 70), accentL = night ? clamp(l, 54, 66) : clamp(l, 42, 56);
  root.setProperty("--accent", hsl(h, accentS, accentL));

  // Buttons carry text, so their fill must clear 4.5:1 with its ink. Nudge the accent's
  // lightness until one of white or near-black works; keep --accent for decorative fills.
  const darkInk = "#1d1a24", darkLum = relativeLuminance([0x1d / 255, 0x1a / 255, 0x24 / 255]);
  let buttonL = accentL, ink = "#fff";
  for (let step = 0; step < 24; step++) {
    const lum = relativeLuminance(hslToRgb(h, accentS, buttonL));
    const onWhite = 1.05 / (lum + 0.05);
    const onDark = (lum + 0.05) / (darkLum + 0.05);
    if (onWhite >= 4.5) { ink = "#fff"; break; }
    if (onDark >= 4.5) { ink = darkInk; break; }
    buttonL += onWhite >= onDark ? -1 : 1;
  }
  root.setProperty("--accent-button", hsl(h, accentS, buttonL));
  root.setProperty("--accent-ink", ink);

  root.setProperty("--accent-strong", night
    ? hsl(h, clamp(s, 30, 66), clamp(l + 14, 68, 82))
    : hsl(h, clamp(s, 38, 74), clamp(l - 16, 26, 40)));
  root.setProperty("--tint-a", hsl(h, clamp(s * 0.55, 18, 40), night ? 18 : 88));
  root.setProperty("--tint-b", hsl(h + 34, clamp(s * 0.45, 14, 32), night ? 22 : 90));
  root.setProperty("--bg-base", hsl(h, 22, night ? 8 : 93));
}

// Two gradient layers, so a new song can fade in behind the old one instead of snapping.
function paintBackdrop(url) {
  const night = document.documentElement.dataset.theme === "night";
  const { h, s } = palette;
  const next = bgOn === "A" ? $("bgB") : $("bgA");
  const prev = bgOn === "A" ? $("bgA") : $("bgB");
  next.style.background =
    `radial-gradient(120% 100% at 12% -10%, ${hsl(h, clamp(s, 20, 60), night ? 26 : 88)}, transparent 62%),` +
    `radial-gradient(90% 80% at 92% 8%, ${hsl(h + 40, clamp(s * 0.8, 16, 52), night ? 22 : 90)}, transparent 66%),` +
    `linear-gradient(165deg, ${hsl(h + 10, 24, night ? 10 : 95)}, ${hsl(h + 70, 20, night ? 13 : 92)})`;
  next.classList.add("on");
  prev.classList.remove("on");
  bgOn = bgOn === "A" ? "B" : "A";
  const bgArt = $("bgArt");
  if (url) { bgArt.style.backgroundImage = `url("${url}")`; bgArt.classList.add("on"); }
  else bgArt.classList.remove("on");
}

function setArtwork(url) {
  url = url || "";
  if (url === artUrl) return;
  artUrl = url;
  if (!url) { palette = { h: 288, s: 42, l: 56 }; paintPalette(); paintBackdrop(""); return; }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (artUrl !== url) return;   // the song changed while the cover was decoding
    try {
      artCtx.clearRect(0, 0, 20, 20);
      artCtx.drawImage(img, 0, 0, 20, 20);
      palette = readPalette(artCtx.getImageData(0, 0, 20, 20).data);
    } catch {}
    paintPalette();
    paintBackdrop(url);
  };
  img.onerror = () => { if (artUrl === url) { paintPalette(); paintBackdrop(""); } };
  img.src = url;
}
paintPalette();
paintBackdrop("");

// ---- what's playing, whichever engine it is ---------------------------------------------------
const localItem = () => (localMode ? localQueue[localIndex] || null : null);
const isPlaying = () => (localItem() ? !localAudio.paused : !!music?.isPlaying);

function nowItem() {
  const t = localItem();
  if (t) return t;
  const it = music?.nowPlayingItem;
  if (!it) return null;
  const a = it.attributes || {};
  return {
    id: it.id,
    playId: it.playParams?.id || a.playParams?.id || "",
    apple: true,
    preview: !!it.isPreview,
    title: it.title || a.name || "",
    artist: it.artistName || a.artistName || "",
    album: it.albumName || a.albumName || "",
    art: a.artwork || it.artwork,
    ms: it.playbackDuration || a.durationInMillis || 0,
  };
}

function currentDuration() {
  if (localItem()) {
    const d = localAudio.duration;
    return Number.isFinite(d) && d > 0 ? d : (localItem().ms || 0) / 1000;
  }
  return music?.currentPlaybackDuration || 0;
}

// MusicKit's currentPlaybackTime is floored to whole seconds, far too coarse for lyrics.
// The <audio> element MusicKit plays through has the real position. When a song follows on by itself,
// MusicKit can move to another element and leave the old one sitting at the end of the last song, so
// only an element that agrees with MusicKit's own (floored) time is believed.
function playTime() {
  const coarse = music?.currentPlaybackTime || 0;
  let best = null;
  for (const a of $$("audio, video")) {
    if (a === localAudio || !a.currentSrc || !Number.isFinite(a.currentTime) || Math.abs(a.currentTime - coarse) > 1.5) continue;
    if (!best || (best.paused && !a.paused)) best = a;
  }
  return best ? best.currentTime : coarse;
}

const currentTime = () => (localItem() ? localAudio.currentTime || 0 : playTime());

// ---- the two players' faces -------------------------------------------------------------------
function setArt(img, fallback, url) {
  if (!url) { img.removeAttribute("src"); img.hidden = true; fallback.hidden = false; return; }
  fallback.hidden = true;
  img.hidden = false;
  if (img.getAttribute("src") !== url) img.src = url;
}

function setItem() {
  const it = nowItem();
  const playing = isPlaying();
  const title = it?.title || "Nothing playing";
  const artist = it?.artist || "";

  $("miniTitle").textContent = title;
  $("miniArtist").textContent = artist || (it ? "" : "Choose something to start");
  $("title").textContent = title;
  $("artist").textContent = artist || (it ? "" : "Pick a track");
  $("album").textContent = it?.album || "";
  $("album").hidden = !it?.album;
  document.title = it ? (artist ? `${title} — ${artist}` : title) : "Orchard";

  const cover = it ? itemArt(it, 900) : "";
  setArt($("miniArt"), $("miniArtFallback"), it ? itemArt(it, 240) : "");
  setArt($("artImg"), $("artFallback"), cover);
  if (cover) $("playerBgArt").src = cover;
  else $("playerBgArt").removeAttribute("src");
  $("playerBgArt").hidden = !cover;

  const badge = $("badge");
  if (!it || it.preview) badge.hidden = true;
  else if (it.local) {
    badge.hidden = false;
    badge.textContent = [it.format, it.bitsPerSample && `${it.bitsPerSample}-bit`].filter(Boolean).join(" · ") || "Local";
  } else {
    badge.hidden = !music?.isAuthorized;
    badge.textContent = "256 kbps";
  }

  $("art").classList.toggle("playing", playing);
  setArtwork(cover);
  if (it?.artist) glass.artistPhoto(it.artist).catch(() => {});
  updateMediaSession();
}

function setPlayingUI() {
  const playing = isPlaying();
  for (const id of ["play", "miniPlay"]) {
    const b = $(id);
    b.querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play");
    b.title = playing ? "Pause" : "Play";
    b.setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  $("art").classList.toggle("playing", playing);
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const it = nowItem();
  if (!it) { navigator.mediaSession.metadata = null; return; }
  const cover = itemArt(it, 600);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: it.title || "",
    artist: it.artist || "",
    album: it.album || "",
    artwork: cover ? [{ src: cover, sizes: "600x600" }] : [],
  });
}

function positionState() {
  const dur = currentDuration();
  if (!(dur > 0) || !("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  // Without this, system media controls (and scrobblers reading them) see every song as an endless stream.
  try { navigator.mediaSession.setPositionState({ duration: dur, position: clamp(currentTime(), 0, dur), playbackRate: 1 }); } catch {}
}

// The times under the seek bar, or the time left when you click the total (remembered).
function showTimes(cur, dur) {
  $("cur").textContent = fmt(cur);
  $("miniCur").textContent = fmt(cur);
  $("dur").textContent = prefs.timeLeft ? "-" + fmt(Math.max(0, dur - Math.floor(cur))) : fmt(dur);
  $("miniDur").textContent = fmt(dur);

  const frac = dur > 0 ? clamp(cur / dur, 0, 1) : 0;
  if (!seeking) {
    const s = $("seek");
    s.value = String(frac);
    s.setAttribute("aria-valuetext", `${fmt(cur)} of ${fmt(dur)}`);
  }
  $("miniSeekFill").style.width = `${frac * 100}%`;
  $("miniSeekKnob").style.left = `${frac * 100}%`;
  $("miniStatusLine").style.width = `${frac * 100}%`;
  const wrap = $("miniSeekWrap");
  wrap.setAttribute("aria-valuemax", String(Math.round(dur)));
  wrap.setAttribute("aria-valuenow", String(Math.round(cur)));
  wrap.setAttribute("aria-valuetext", `${fmt(cur)} of ${fmt(dur)}`);
}

function syncTime() {
  if (seeking) return;
  showTimes(currentTime(), currentDuration());
  positionState();
}

$("dur").onclick = () => {
  prefs.timeLeft = !prefs.timeLeft; savePrefs();
  $("dur").title = prefs.timeLeft ? "Click to show the length" : "Click to show time left";
  showTimes(currentTime(), currentDuration());
};
if (prefs.timeLeft) $("dur").title = "Click to show the length";

function markPlaying() {
  const it = nowItem();
  const id = it ? String(it.id) : "";
  const key = it?.playId ? String(it.playId) : "";
  $$("#content .song-card, #content .track-row, #content .cover-card").forEach(node => {
    const pid = node.dataset.id || "", ppid = node.dataset.play || "";
    node.classList.toggle("on", !!id && ((pid && pid === id) || (key && ppid === key)));
  });
  paintHearts();
}

function paintHearts() {
  $$("#content [data-idx]").forEach(card => {
    const btn = card.querySelector(".heart-btn");
    if (!btn) return;
    const on = isFavourite(items[+card.dataset.idx]);
    btn.classList.toggle("on", !!on);
    btn.title = on ? "Remove from Favorites" : "Favorite";
    btn.setAttribute("aria-label", btn.title);
  });
  const it = nowItem(), on = isFavourite(it);
  for (const id of ["miniFav", "playerFav"]) {
    const b = $(id);
    b.classList.toggle("on", !!on);
    b.title = on ? "Remove from Favorites" : "Favorite";
    b.setAttribute("aria-label", b.title);
  }
}

// ---- volume -----------------------------------------------------------------------------------
// The level lives here: the vertical bar above each mute button is the control, and the wheel, the keyboard
// and the mute button all move the same value. Muting isn't remembered as the volume, so the next launch
// doesn't start silent; unmuting goes back to where it was.
let volume = 0.8;
let unmuted = null;
function setVolume(v, remember = true) {
  volume = Math.round(clamp(v, 0, 1) * 100) / 100;
  if (music) music.volume = volume;
  localAudio.volume = volume;
  if (volume > 0 && remember) { unmuted = null; prefs.volume = volume; savePrefs(); }
  showVolume();
}
function showVolume() {
  const muted = volume === 0;
  for (const id of ["miniVolumeIcon", "playerVolumeIcon"]) {
    const b = $(id);
    b.classList.toggle("muted", muted);
    b.setAttribute("aria-label", muted ? "Unmute (M)" : "Mute (M)");
    b.querySelector("use").setAttribute("href", muted ? "#i-mute" : "#i-volume");
  }
  paintVolPops();
}
// The bar above each mute button, in the cover's accent. One value, so nothing can drift out of step.
function paintVolPops() {
  const level = Math.round(volume * 100);
  for (const id of ["miniVolPop", "volPop"]) {
    const pop = $(id);
    if (!pop) continue;
    pop.style.setProperty("--vol", level + "%");
    pop.querySelector(".vol-pop-num").textContent = level + "%";
    pop.classList.toggle("muted", level === 0);
    pop.setAttribute("aria-valuenow", String(level));
    pop.setAttribute("aria-valuetext", level + "%");
  }
}
function toggleMute() {
  if (volume > 0) { unmuted = volume; setVolume(0, false); }
  else setVolume(unmuted || prefs.volume || 0.8);
}

volume = prefs.rememberVolume && prefs.volume != null ? clamp(prefs.volume, 0, 1) : 0.8;
localAudio.volume = volume;
showVolume();

for (const id of ["miniVolumeIcon", "playerVolumeIcon"]) {
  const b = $(id);
  b.onclick = toggleMute;
  b.parentElement.addEventListener("wheel", e => {     // the wheel works over the button and the open bar
    e.preventDefault();
    setVolume(volume - Math.sign(e.deltaY) * 0.05);
  }, { passive: false });
}

// Tap or drag the bar to set the level. Hovering the bar keeps it open (it is inside the same anchor), the
// bridge in its CSS covers the gap below, and `dragging` holds it open if the pointer strays.
function volFromPointer(pop, e) {
  const r = pop.querySelector(".vol-pop-track").getBoundingClientRect();
  setVolume((r.bottom - e.clientY) / r.height);
}
for (const id of ["miniVolPop", "volPop"]) {
  const pop = $(id), anchor = pop.parentElement;
  pop.addEventListener("pointerdown", e => {
    e.preventDefault();
    pop.focus({ preventScroll: true });
    pop.setPointerCapture(e.pointerId);
    anchor.classList.add("dragging");
    volFromPointer(pop, e);
  });
  pop.addEventListener("pointermove", e => { if (pop.hasPointerCapture(e.pointerId)) volFromPointer(pop, e); });
  const release = e => {
    try { pop.releasePointerCapture(e.pointerId); } catch {}
    anchor.classList.remove("dragging");
  };
  pop.addEventListener("pointerup", release);
  pop.addEventListener("pointercancel", release);
  pop.addEventListener("keydown", e => {
    const step = e.shiftKey ? 0.1 : 0.05;
    const handle = fn => { e.preventDefault(); e.stopPropagation(); fn(); };   // don't let the page also nudge
    if (e.key === "ArrowUp" || e.key === "ArrowRight") handle(() => setVolume(volume + step));
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") handle(() => setVolume(volume - step));
    else if (e.key === "Home") handle(() => setVolume(0));
    else if (e.key === "End") handle(() => setVolume(1));
  });
}

// ---- start MusicKit (the Cider way: web player's developer token + Widevine) --------------------
document.addEventListener("musickitloaded", start);
if (window.MusicKit) start();

async function start() {
  if (music) return;
  try {
    music = await configure(await glass.token());
  } catch {
    try { music = await configure(await glass.token(true)); }          // token rotated
    catch (e) { status("Couldn't start Apple Music: " + (e?.message || e), true); return; }
  }
  const acc = await glass.account();
  if (acc?.token) music.musicUserToken = acc.token;

  lockQuality();
  music.addEventListener("playbackBitrateDidChange", lockQuality);
  music.volume = volume;
  setAutoplay(prefs.autoplay);

  music.addEventListener("playbackStateDidChange", onState);
  music.addEventListener("playbackVolumeDidChange", () => {
    report();
    if (Math.abs(music.volume - volume) > 0.005) setVolume(music.volume, false);
    showVolume();
  });
  setInterval(() => { if (music.isPlaying && !localItem()) report(); }, 5000);   // keeps the position honest
  music.addEventListener("nowPlayingItemDidChange", onItem);
  music.addEventListener("playbackTimeDidChange", onTime);
  music.addEventListener("playbackDurationDidChange", () => { report(); onTime(); });
  music.addEventListener("authorizationStatusDidChange", refreshAccount);
  music.addEventListener("queueItemsDidChange", renderQueue);
  music.addEventListener("queuePositionDidChange", renderQueue);
  music.addEventListener("shuffleModeDidChange", modes);
  music.addEventListener("repeatModeDidChange", modes);
  modes();
  music.addEventListener("mediaPlaybackError", e => status("Playback error: " + (e?.message || e?.errorCode || "unknown"), true));

  refreshAccount();          // also makes today's Suggested Music playlist, if that toggle is on
  setView("home");
  load();
  if (!music.isAuthorized) status("Sign in for Apple Music; your own files are ready.");
}

function configure(developerToken) {
  return MusicKit.configure({
    developerToken,
    app: { name: "Orchard", build: "1.0.0", version: "1.0" },
    bitrate: MusicKit.PlaybackBitrate.HIGH,
    suppressErrorDialog: true,
  }).then(m => m || MusicKit.getInstance());
}

// MusicKit starts at 64 kbps and may switch down on its own. Keep it at 256 kbps AAC, the highest it streams.
function lockQuality() {
  if (music.bitrate !== MusicKit.PlaybackBitrate.HIGH) music.bitrate = MusicKit.PlaybackBitrate.HIGH;
}

function onState() {
  if (localItem()) return;
  setPlayingUI();
  report();
}

function onItem() {
  localMode = false;
  if (!localAudio.paused) localAudio.pause();
  setItem();
  setPlayingUI();
  if (stageOpen) refreshStage(); else if (pane === "lyrics") loadLyrics();
  renderQueue();
  markPlaying();
  report();
}

function onTime() {
  if (localItem()) return;
  if (seeking || !music?.currentPlaybackDuration) return;
  showTimes(music.currentPlaybackTime || 0, music.currentPlaybackDuration);
  positionState();
}

// ---- local playback ---------------------------------------------------------------------------
function playLocalAt(i) {
  const t = localQueue[i];
  if (!t) return;
  localIndex = i;
  localMode = true;
  if (music?.isPlaying) music.pause();
  countPlay(t);
  localAudio.src = t.src;
  localAudio.play().catch(e => status(`Couldn't play ${t.title}: ${e?.message || e}`, true));
  ensureEQ();
  setItem();
  setPlayingUI();
  if (stageOpen) refreshStage();
  renderQueue();
  markPlaying();
  report();
}

function localNext(auto = false) {
  if (!localQueue.length) return;
  if (auto && localRepeat === 1) { localAudio.currentTime = 0; localAudio.play().catch(() => {}); return; }
  let i = localIndex + 1;
  if (i >= localQueue.length && auto && prefs.autoplay && !localRepeat) {
    // Keep playing when the queue ends, the way the label promises: a fresh handful from the library.
    const pool = local.tracks.filter(t => !localQueue.includes(t));
    if (pool.length) { localQueue.push(...shuffled(pool).slice(0, 30)); renderQueue(); }
  }
  if (i >= localQueue.length) {
    if (localRepeat !== 2) {
      if (auto) { localAudio.pause(); localAudio.currentTime = 0; setPlayingUI(); report(); }
      return;
    }
    i = 0;
  }
  playLocalAt(i);
}

function localPrev() {
  if (!localQueue.length) return;
  if ((localAudio.currentTime || 0) > 3) { localAudio.currentTime = 0; return; }
  const i = localIndex - 1;
  playLocalAt(i < 0 ? (localRepeat === 2 ? localQueue.length - 1 : 0) : i);
}

// Hand the output back to Apple Music: stop the file, drop the element's source, forget the position.
function leaveLocal() {
  if (!localMode) return;
  localMode = false;
  localIndex = -1;
  localAudio.pause();
  localAudio.removeAttribute("src");
  localAudio.load();
}

localAudio.addEventListener("play", () => { if (localItem()) { setPlayingUI(); report(); } });
localAudio.addEventListener("pause", () => { if (localItem()) { setPlayingUI(); report(); } });
localAudio.addEventListener("timeupdate", () => { if (localItem()) syncTime(); });
localAudio.addEventListener("durationchange", () => { if (localItem()) syncTime(); });
localAudio.addEventListener("ended", () => { if (localItem()) localNext(true); });
localAudio.addEventListener("error", () => {
  const t = localItem();
  if (t) status(`Couldn't play ${t.title}. The file may have moved.`, true);
  setPlayingUI();
  report();
});

// ---- transport ---------------------------------------------------------------------------------
function togglePlay() {  if (localItem()) {
    if (localAudio.paused) localAudio.play().catch(e => status("Couldn't play: " + (e?.message || e), true));
    else localAudio.pause();
    return;
  }
  if (!music?.nowPlayingItem) {
    const i = items.findIndex(t => t.kind === "song");
    if (i >= 0) playAt(i);
    return;
  }
  music.isPlaying ? music.pause() : music.play();
}

function nextTrack() { if (localItem()) localNext(false); else music?.skipToNextItem(); }
function prevTrack() {
  if (localItem()) { localPrev(); return; }
  if (!music) return;
  if (music.currentPlaybackTime > 3) music.seekToTime(0); else music.skipToPreviousItem();
}

$("play").onclick = togglePlay;
$("miniPlay").onclick = togglePlay;
$("next").onclick = nextTrack;
$("miniNext").onclick = nextTrack;
$("prev").onclick = prevTrack;
$("miniPrev").onclick = prevTrack;

function seekTo(t) {
  const dur = currentDuration();
  t = clamp(t, 0, Math.max(dur - 0.05, 0));
  if (localItem()) localAudio.currentTime = t;
  else music?.seekToTime(t).then(() => report({ seeked: true })).catch(() => {});
  showTimes(t, dur);
}

const seek = $("seek");
seek.addEventListener("input", () => {
  seeking = true;
  const dur = currentDuration();
  showTimes(+seek.value * dur, dur);
});
seek.addEventListener("change", () => {
  const dur = currentDuration();
  seeking = false;
  seekTo(+seek.value * dur);
});

// The mini bar's seek line is drawn, not a native slider: drag anywhere on it and the fill follows.
const miniSeek = $("miniSeekWrap");
function miniSeekTime(clientX) {
  const r = miniSeek.getBoundingClientRect();
  const frac = clamp((clientX - r.left) / Math.max(r.width, 1), 0, 1);
  const dur = currentDuration();
  showTimes(frac * dur, dur);
  return frac * dur;
}
miniSeek.addEventListener("pointerdown", e => {
  seeking = true;
  miniSeek.setPointerCapture?.(e.pointerId);
  miniSeekTime(e.clientX);
});
miniSeek.addEventListener("pointermove", e => { if (seeking && miniSeek.hasPointerCapture?.(e.pointerId)) miniSeekTime(e.clientX); });
function endMiniSeek(e) {
  if (!seeking) return;
  const t = miniSeekTime(e.clientX);
  seeking = false;
  seekTo(t);
}
miniSeek.addEventListener("pointerup", endMiniSeek);
miniSeek.addEventListener("pointercancel", e => { seeking = false; syncTime(); });
miniSeek.addEventListener("keydown", e => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const step = (e.shiftKey ? 10 : 5) * (e.key === "ArrowRight" ? 1 : -1);
  seekTo(currentTime() + step);
});

// ---- queue/mode helpers shared by both engines ------------------------------------------------
// A slow, older view must not replace a newer one; every load bumps the job number.
let shuffleLit = false;   // on after we shuffled a list ourselves, even though MusicKit's own mode is off

function modes() {
  const local = !!localItem();
  const shuffleOn = local ? localShuffle : !!(music?.shuffleMode || shuffleLit);
  const repeat = local ? localRepeat : (music?.repeatMode ?? 0);
  $("shuffle").classList.toggle("on", shuffleOn);
  $("miniLyrics").classList.toggle("on", pane === "lyrics" && !$("player").hidden);
  $("repeat").classList.toggle("on", repeat !== 0);
  $("repeat").classList.toggle("one", repeat === 1);
  $("repeat").title = ["Repeat", "Repeat one", "Repeat all"][repeat] || "Repeat";
  $("repeat").setAttribute("aria-label", $("repeat").title);
}

// ---- catalog and library ----------------------------------------------------------------------
// Songs, albums and artists from the catalog or your library, flattened into one list item shape.
function toItem(s) {
  const a = s.attributes;
  if (!a) return null; // unavailable in this storefront
  const lib = s.type.startsWith("library");
  const artwork = a.artwork || s.relationships?.catalog?.data?.[0]?.attributes?.artwork;
  const base = { id: s.id, lib, art: artwork, url: a.url || "", year: (a.releaseDate || "").slice(0, 4) };
  if (s.type.endsWith("albums")) return { ...base, kind: "album", title: a.name, artist: a.artistName, trackCount: a.trackCount || 0 };
  if (s.type.endsWith("artists"))
    return { ...base, kind: "artist", catalogId: lib ? s.relationships?.catalog?.data?.[0]?.id : s.id, title: a.name, artist: "Artist" };
  if (s.type.endsWith("playlists"))
    return { ...base, kind: "playlist", canEdit: !!a.canEdit, title: a.name, artist: a.curatorName || "Playlist" };
  if (s.type === "stations") return { ...base, kind: "station", title: a.name, artist: "Station" };
  if (!a.playParams) return null; // not streamable here
  return {
    ...base, kind: "song", playId: a.playParams.id, catalogId: a.playParams.catalogId,
    title: a.name, artist: a.artistName, album: a.albumName || "", ms: a.durationInMillis || 0,
  };
}

// A song's album and artist, for "Go to Album" and "Go to Artist": the catalogue answers with both
// relationships in one call, then the song's own link, then a search by name as the last resort.
async function relationsOf(item) {
  const id = item.catalogId || item.playId || item.id;
  if (!music?.isAuthorized || !id) return {};
  try {
    const r = await music.api.music(`/v1/catalog/{{storefrontId}}/songs/${id}`, { include: "albums,artists" });
    const d = r?.data?.data?.[0];
    const album = d?.relationships?.albums?.data?.[0];
    const artist = d?.relationships?.artists?.data?.[0];
    return { album: album ? toItem(album) : null, artist: artist ? toItem(artist) : null };
  } catch { return {}; }
}

async function albumOfSong(item) {
  const rel = await relationsOf(item);
  if (rel.album) return rel.album;
  const id = /\/album\/[^/]*\/(\d+)/.exec(item.url || "")?.[1];
  if (id) return { kind: "album", id, title: item.album || item.title, artist: item.artist, art: item.art };
  if (!item.album) return null;
  try {
    const r = await music.api.music(`/v1/catalog/{{storefrontId}}/search`,
      { term: `${item.album} ${item.artist || ""}`.trim(), types: "albums", limit: 1 });
    const hit = r?.data?.results?.albums?.data?.[0];
    return hit ? toItem(hit) : null;
  } catch { return null; }
}

async function artistOfSong(item) {
  const rel = await relationsOf(item);
  if (rel.artist) return rel.artist;
  if (!item.artist) return null;
  try {
    const r = await music.api.music(`/v1/catalog/{{storefrontId}}/search`, { term: item.artist, types: "artists", limit: 1 });
    const hit = r?.data?.results?.artists?.data?.[0];
    return hit ? toItem(hit) : null;
  } catch { return null; }
}

async function amp(method, path, body) {
  const send = () => fetch("https://amp-api.music.apple.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + music.developerToken,
      "media-user-token": music.musicUserToken || "",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await send();
  if (r.status === 429) { await new Promise(done => setTimeout(done, 1500)); r = await send(); }   // asked too fast: once more
  if (!r.ok) throw new Error(`Apple Music answered ${r.status}`);
  return r.status === 200 || r.status === 201 ? r.json().catch(() => null) : null;
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
  if (!music?.isAuthorized) throw new Error(`Sign in (⚙) to see ${what}.`);
}

const LIBRARY = {
  playlists: { path: "/v1/me/library/playlists", params: { limit: 100 } },
  artists: { path: "/v1/me/library/artists", params: { limit: 100, include: "catalog" } },
  albums: { path: "/v1/me/library/albums", params: { limit: 100 } },
  songs: { path: "/v1/me/library/songs", params: { limit: 100 } },
};
const libraryList = id => paged(LIBRARY[id].path, LIBRARY[id].params, id === "songs" ? 3000 : 1000);

// Apple has no "list my favourites" call, so the library is checked in batches of fifty.
async function favourites(kind) {
  const all = kind === "songs" ? (await libraryList("songs")).slice(0, 1000) : await libraryList("albums");
  const on = new Set();
  for (let i = 0; i < all.length; i += 50) {
    try {
      const r = await amp("GET", `/v1/me/ratings/${kind}?ids=${all.slice(i, i + 50).map(x => x.id).join(",")}`);
      for (const x of r?.data || []) if (x.attributes?.value === 1) on.add(x.id);
    } catch {}
  }
  return all.filter(x => on.has(x.id));
}

// The songs inside an album, playlist or artist, for playing, queueing and adding to playlists.
async function tracksOf(item) {
  if (item.local) {
    if (item.kind === "song") return [item];
    if (item.kind === "playlist") return item.tracks || [];
    if (item.kind === "album") return item.tracks || local.tracks.filter(t => t.albumKey === item.albumKey);
    if (item.kind === "artist") return item.tracks || local.tracks.filter(t => (t.albumArtist || t.artist || "") === item.title);
    return [];
  }
  if (item.kind === "song") return [item];
  if (item.kind === "album")
    return paged(item.lib ? `/v1/me/library/albums/${item.id}/tracks` : `/v1/catalog/{{storefrontId}}/albums/${item.id}/tracks`, { limit: 100 });
  if (item.kind === "playlist")
    return paged(item.lib ? `/v1/me/library/playlists/${item.id}/tracks` : `/v1/catalog/{{storefrontId}}/playlists/${item.id}/tracks`, { limit: 100 }, 1000);
  if (item.kind === "artist") return (await artistPage(item)).songs || [];
  if (item.kind === "category" && item.id === "songs") return libraryList("songs");
  return [];
}

// ---- views -------------------------------------------------------------------------------------
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const icon = id => `<svg class="icon"><use href="#${id}"/></svg>`;
const iconBtn = (name, cls, title) => {
  const b = el("button", `icon-btn ${cls || ""}`.trim());
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = icon(name);
  return b;
};
const pillBtn = (label, cls, iconId) => {
  const b = el("button", `pill-btn ${cls || ""}`.trim());
  b.type = "button";
  if (iconId) b.innerHTML = icon(iconId);
  b.appendChild(document.createTextNode(label));
  return b;
};
const greetingFor = () => {
  const h = new Date().getHours();
  return h < 5 ? "Still up?" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const dedupe = list => {
  const seen = new Set();
  return list.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
};

let searchScope = "all";   // all | apple | files

function localSearch(term) {
  const q = term.toLowerCase();
  const has = v => (v || "").toLowerCase().includes(q);
  return {
    tracks: local.tracks.filter(t => has(t.title) || has(t.artist) || has(t.album) || has(t.albumArtist)),
    albums: local.albums.filter(a => has(a.title) || has(a.artist)),
    artists: local.artists.filter(a => has(a.title)),
  };
}

async function searchPage(term) {
  const link = term.match(/music\.apple\.com\/([a-z]{2})\/(album|playlist)\/(?:[^/]+\/)?([\w.\-]+)/i);
  if (link) {
    const song = term.match(/[?&]i=(\d+)/)?.[1];
    if (song) {
      const r = await music.api.music(`/v1/catalog/${link[1]}/songs/${song}`);
      const found = (r.data.data || []).map(toItem).filter(Boolean);
      return { title: "Search", sub: "From the link you pasted", scope: searchScope, sections: found.length ? [{ title: "Song", items: found, layout: "tracks", hideHead: true }] : [], songs: found };
    }
    const tracks = await paged(`/v1/catalog/${link[1]}/${link[2]}s/${link[3]}/tracks`, { limit: 100 });
    return {
      title: "Search", sub: "From the link you pasted", scope: searchScope,
      sections: tracks.length ? [{ title: link[2] === "album" ? "Album" : "Playlist", items: tracks, layout: "tracks" }] : [],
      songs: tracks,
    };
  }

  await loadLocal();
  const mine = localSearch(term);
  const sections = [];
  if (searchScope !== "apple" && (mine.tracks.length || mine.albums.length || mine.artists.length)) {
    if (mine.tracks.length) sections.push({ title: "Your files", items: mine.tracks.slice(0, 8), layout: "tracks" });
    if (mine.albums.length) sections.push({ title: "Your albums", items: mine.albums.slice(0, 6), layout: "covers" });
    if (mine.artists.length) sections.push({ title: "Your artists", items: mine.artists.slice(0, 6), layout: "artists" });
  }

  let appleError = "";
  if (searchScope !== "files" && music) {
    try {
      const r = await music.api.music("/v1/catalog/{{storefrontId}}/search", {
        term, types: "songs,artists,albums,playlists", limit: 8,
      });
      const found = r.data?.results || {};
      const take = kind => (found[kind]?.data || []).map(toItem).filter(Boolean);
      sections.push(...[
        { title: "Songs", items: take("songs"), layout: "tracks" },
        { title: "Artists", items: take("artists"), layout: "artists" },
        { title: "Albums", items: take("albums"), layout: "covers" },
        { title: "Playlists", items: take("playlists"), layout: "covers" },
      ].filter(s => s.items.length));
    } catch (e) { appleError = e?.message || String(e); }
  }

  return {
    title: `“${term}”`, kicker: "Search", scope: searchScope, sections,
    songs: sections.find(s => s.title === "Songs")?.items,
    sub: appleError ? "Apple Music couldn't be reached; showing what is on this machine." : "",
    empty: sections.length ? null : {
      icon: "i-search", title: "Nothing found",
      text: appleError || (searchScope === "files" ? "No file matches those words." : "Try different words, or a different scope."),
    },
  };
}

async function homePage() {
  await loadLocal();
  const signedIn = !!music?.isAuthorized;
  const sections = [];

  if (signedIn) {
    try {
      const r = await music.api.music("/v1/me/recommendations", { limit: 12 });
      for (const group of r.data?.data || []) {
        const contents = (group.relationships?.contents?.data || []).map(toItem).filter(Boolean);
        if (!contents.length) continue;
        sections.push({
          title: group.attributes?.title?.stringForDisplay || "For You",
          items: contents,
          layout: contents.every(x => x.kind === "artist") ? "artists" : "row",
        });
      }
    } catch {}
  }

  const recent = recentLocal();
  if (recent.length) sections.push({ title: "Continue listening", items: recent.slice(0, 8), layout: "tracks" });
  if (local.albums.length) sections.push({ title: "From your files", items: local.albums.slice(0, 10), layout: "row", shuffle: true });

  const hello = sections[0]?.items[0];
  return {
    greeting: { kicker: signedIn ? "For You" : "Your files", title: greetingFor(), art: hello ? itemArt(hello, 160) : "" },
    sections,
    empty: sections.length ? null : {
      icon: "i-folder", title: signedIn ? "Nothing to play yet" : "Your files, first",
      text: signedIn
        ? "Play something and Apple Music will start suggesting things."
        : "Add a folder of music, or sign in for Apple Music. Orchard reads your files locally and never uploads them.",
      actions: [["Add a folder", "addFolder"], ...(signedIn ? [] : [["Sign in", "signIn"]])],
    },
  };
}

async function artistPage(item) {
  const id = item.catalogId;
  const hero = { kicker: "Artist", title: item.title, art: itemArt(item, 600), item };
  if (!id) {
    const albums = await paged(`/v1/me/library/artists/${item.id}/albums`, { limit: 100 });
    return { hero, sections: albums.length ? [{ title: "Albums", items: albums, layout: "covers" }] : [] };
  }
  const [top, albums] = await Promise.all([
    music.api.music(`/v1/catalog/{{storefrontId}}/artists/${id}/view/top-songs`, { limit: 20 })
      .then(r => (r.data.data || []).map(toItem).filter(Boolean)).catch(() => []),
    paged(`/v1/catalog/{{storefrontId}}/artists/${id}/albums`, {}, 300).catch(() => []),
  ]);
  hero.meta = [top.length && `${top.length} top songs`, albums.length && `${albums.length} albums`].filter(Boolean);
  return {
    hero,
    songs: top,
    sections: [
      top.length && { title: "Top Songs", items: top, layout: "tracks" },
      albums.length && { title: "Albums", items: albums, layout: "covers" },
    ].filter(Boolean),
  };
}

async function albumPage(item) {
  const tracks = await tracksOf(item);
  const total = tracks.reduce((n, t) => n + (t.ms || 0), 0);
  return {
    hero: {
      kicker: item.lib ? "Album · Your Library" : "Album",
      title: item.title,
      artist: item.artist,
      art: itemArt(item, 900),
      meta: [item.year, `${tracks.length} song${tracks.length === 1 ? "" : "s"}`, total ? fmt(total / 1000) : ""].filter(Boolean),
      item,
    },
    songs: tracks,
    sections: tracks.length ? [{ title: "Songs", items: tracks, layout: "tracks", hideHead: true, album: item.title }] : [],
    empty: tracks.length ? null : { icon: "i-disc", title: "Nothing to play", text: "This album isn't available in your storefront." },
  };
}

async function playlistPage(item) {
  const tracks = await tracksOf(item);
  const total = tracks.reduce((n, t) => n + (t.ms || 0), 0);
  return {
    hero: {
      kicker: item.local ? "Playlist · Your files" : item.lib ? "Playlist · Your Library" : "Playlist",
      title: item.title, artist: item.artist, art: itemArt(item, 900),
      meta: [`${tracks.length} song${tracks.length === 1 ? "" : "s"}`, total ? fmt(total / 1000) : ""].filter(Boolean),
      item,
    },
    songs: tracks,
    sections: tracks.length ? [{ title: "Songs", items: tracks, layout: "tracks", hideHead: true, album: item.title }] : [],
    empty: tracks.length ? null : {
      icon: "i-music", title: "Empty playlist",
      text: item.local ? "Use Add to Playlist… on any song, album or artist." : "There's nothing in here yet.",
    },
  };
}

function listPage(title, list, layout, sub, asSongs) {
  return {
    title, sub, kicker: "Your Library",
    sections: list.length ? [{ title, items: list, layout, hideHead: true }] : [],
    songs: asSongs ? list : undefined,
    empty: { icon: "i-music", title: "Nothing here yet", text: "Apple Music has nothing in this part of your library." },
  };
}

function recentLocal() {
  return recentIds.map(id => local.tracks.find(t => t.id === id)).filter(Boolean);
}

async function recentPage() {
  const sections = [];
  if (music?.isAuthorized) {
    try {
      const r = await music.api.music("/v1/me/recent/played/tracks", { types: "songs", limit: 30 });
      const list = (r.data?.data || []).map(toItem).filter(Boolean);
      if (list.length) sections.push({ title: "From Apple Music", items: list, layout: "tracks" });
    } catch {}
  }
  const mine = recentLocal();
  if (mine.length) sections.push({ title: "Your files", items: mine, layout: "tracks" });
  return {
    title: "Recently Played", kicker: "Listening", sections,
    empty: { icon: "i-clock", title: "Nothing played yet", text: "Songs you play show up here, newest first." },
  };
}

function mostPlayedPage() {
  const scored = local.albums
    .map(a => ({ a, n: (a.tracks || []).reduce((sum, t) => sum + (plays[t.id] || 0), 0) }))
    .filter(x => x.n > 0)
    .sort((x, y) => y.n - x.n);
  return {
    title: "Most Played", kicker: "Listening",
    sub: scored.length ? "Albums you've played the most, counted from your own files" : "",
    sections: scored.length ? [{ title: "Your files", items: scored.map(x => x.a), layout: "covers" }] : [],
    empty: {
      icon: "i-spark", title: "No plays counted yet",
      text: "Orchard counts plays of the files on this machine. Apple Music doesn't share its own listening counts, so nothing here comes from the service.",
    },
  };
}

async function radiosPage() {
  needSignIn("radio stations");
  const found = [];
  try {
    const r = await music.api.music("/v1/me/recommendations", { limit: 12 });
    for (const group of r.data?.data || [])
      for (const x of group.relationships?.contents?.data || []) {
        const it = toItem(x);
        if (it?.kind === "station") found.push(it);
      }
  } catch {}
  if (!found.length) {
    const r = await music.api.music("/v1/catalog/{{storefrontId}}/search", { term: "radio", types: "stations", limit: 25 });
    found.push(...(r.data?.results?.stations?.data || []).map(toItem).filter(Boolean));
  }
  return listPage("Radios", dedupe(found), "covers", "Stations picked for you");
}

function localPage() {
  if (!local.tracks.length) {
    return {
      title: "Local Files", sub: "FLAC, MP3, M4A, OGG, Opus, WAV and AIFF",
      empty: {
        icon: "i-folder", title: "No music here yet",
        text: "Add a folder and Orchard reads the tags, lengths and covers straight from your files. Nothing leaves this machine.",
        actions: [["Add folder", "addFolder"], ["Add files", "addFiles"]],
      },
    };
  }
  const sections = [];
  if (localFilter === "all" || localFilter === "albums") {
    sections.push({ title: "Albums", items: local.albums, layout: "covers" });
  }
  if (localFilter === "all" || localFilter === "artists") {
    sections.push({ title: "Artists", items: local.artists, layout: "artists" });
  }
  if (localFilter === "all" || localFilter === "songs") {
    sections.push({
      title: "Songs", items: local.tracks.slice(0, 400), layout: "tracks",
      note: local.tracks.length > 400 ? `Showing the first 400 of ${local.tracks.length}.` : "",
    });
  }
  return {
    title: "Local Files",
    sub: `${local.tracks.length} songs · ${local.albums.length} albums · ${local.artists.length} artists`,
    filters: { active: localFilter, items: LOCAL_FILTERS, kind: "local" },
    sections,
    songs: localFilter === "songs" ? local.tracks : undefined,
    shuffleAlbums: localFilter === "all" || localFilter === "albums" ? local.albums : undefined,
  };
}

let libraryFilter = "albums";
let localFilter = "all";
const LOCAL_FILTERS = [["all", "All"], ["albums", "Albums"], ["artists", "Artists"], ["songs", "Songs"]];
const LIBRARY_FILTERS = [
  ["albums", "Albums"], ["songs", "Songs"], ["artists", "Artists"], ["playlists", "Playlists"],
  ["recentAdded", "Recently Added"], ["recentPlayed", "Recently Played"], ["mostPlayed", "Most Played"],
  ["favorites", "Favorites"], ["radios", "Radios"],
];

async function libraryPage(filter = libraryFilter) {
  libraryFilter = filter;
  const signedIn = !!music?.isAuthorized;
  const page = { title: "Library", kicker: "Your Library", filters: { active: filter, items: LIBRARY_FILTERS }, sections: [] };
  const gate = () => { if (!signedIn) throw new Error("Sign in to Apple Music to see this part of your library."); };

  try {
    if (filter === "albums") {
      gate();
      page.sections = [{ title: "Albums", items: await libraryList("albums"), layout: "covers", hideHead: true }];
      page.shuffleAlbums = page.sections[0]?.items || [];
    } else if (filter === "songs") {
      gate();
      const list = await libraryList("songs");
      page.sections = [{ title: "Songs", items: list, layout: "tracks", hideHead: true }];
      page.songs = list;
    } else if (filter === "artists") {
      gate();
      page.sections = [{ title: "Artists", items: await libraryList("artists"), layout: "artists", hideHead: true }];
    } else if (filter === "playlists") {
      await loadLocal();
      const mine = localPlaylists.map(localPlaylistItem);
      let apple = [];
      if (signedIn) { try { apple = await libraryList("playlists"); } catch {} }
      page.sections = [
        mine.length && { title: "Your playlists", items: mine, layout: "covers" },
        apple.length && { title: "Apple Music", items: apple, layout: "covers" },
      ].filter(Boolean);
      page.newPlaylist = true;
      if (!page.sections.length) page.empty = { icon: "i-music", title: "No playlists yet", text: "Make one, then use Add to Playlist… on any song, album or artist." };
    } else if (filter === "recentAdded") {
      gate();
      page.sections = [{ title: "Recently Added", items: await paged("/v1/me/library/recently-added", { limit: 100 }, 300), layout: "covers", hideHead: true }];
    } else if (filter === "radios") {
      page.sections = (await radiosPage()).sections;
    } else if (filter === "recentPlayed") {
      page.sections = (await recentPage()).sections;
    } else if (filter === "mostPlayed") {
      await loadLocal();
      page.sections = mostPlayedPage().sections;
    } else if (filter === "favorites") {
      await loadLocal();
      const mine = local.tracks.filter(t => localFavs.has(t.id));
      if (mine.length) page.sections.push({ title: "Your files", items: mine, layout: "tracks" });
      let appleSongs = [];
      if (signedIn) {
        status("Checking your favourites…");
        const [albums, songs] = await Promise.all([favourites("albums"), favourites("songs")]);
        appleSongs = songs;
        if (albums.length) page.sections.push({ title: "Favorite Albums", items: albums, layout: "covers" });
        if (songs.length) page.sections.push({ title: "Favorite Songs", items: songs, layout: "tracks" });
      }
      page.songs = [...mine, ...appleSongs];
    }
  } catch (e) {
    page.sections = [];
    page.empty = {
      icon: "i-music", title: signedIn ? "Nothing here yet" : "Sign in to Apple Music",
      text: e?.message || "", actions: signedIn ? [] : [["Connect", "signIn"]],
    };
  }

  if (!page.empty && !page.sections.some(s => s.items?.length)) {
    page.empty = { icon: "i-music", title: "Nothing here yet", text: "This part of your library is empty." };
  }
  return page;
}

const VIEWS = {
  home: homePage,
  library: async () => libraryPage(libraryFilter),
  artists: async () => { needSignIn("your artists"); return listPage("Artists", await libraryList("artists"), "artists", "From your library"); },
  albums: async () => { needSignIn("your saved albums"); return listPage("Albums", await libraryList("albums"), "covers", "Everything you've saved"); },
  randomAlbums: async () => { needSignIn("your albums"); return listPage("Random Albums", shuffled(await libraryList("albums")), "covers", "Your albums, in a new order each time"); },
  favoritesAlbums: async () => { needSignIn("your favourites"); status("Checking your favourites…"); return listPage("Favorite Albums", await favourites("albums"), "covers", "Albums you've loved"); },
  recentAdded: async () => { needSignIn("recently added"); return listPage("Recently Added", await paged("/v1/me/library/recently-added", { limit: 100 }, 300), "covers", "The newest in your library"); },
  recentPlayed: recentPage,
  mostPlayed: async () => { await loadLocal(); return mostPlayedPage(); },
  songs: async () => { needSignIn("your songs"); return listPage("Songs", await libraryList("songs"), "tracks", "Every song in your library", true); },
  favoritesSongs: async () => {
    needSignIn("your favourites");
    status("Checking your favourites…");
    await loadLocal();
    const list = [...await favourites("songs"), ...local.tracks.filter(t => localFavs.has(t.id))];
    return listPage("Favorite Songs", list, "tracks", "Songs you've loved", true);
  },
  radios: radiosPage,
  suggested: async () => { return suggestedPage(); },
  local: async () => { await loadLocal(); return localPage(); },
};

// ---- page rendering ----------------------------------------------------------------------------
let lastPage = null;

function pageHead(page) {
  const head = el("div", "page-head");
  const copy = el("div");
  if (page.kicker) copy.appendChild(el("div", "hero-kicker", page.kicker));
  copy.appendChild(el("h1", "", page.title));
  if (page.sub) copy.appendChild(el("div", "sub", page.sub));
  head.appendChild(copy);
  const actions = el("div", "head-actions");
  let hasActions = false;
  if (page.songs?.length) {
    const play = pillBtn("Play all", "primary", "i-play");
    play.onclick = () => playAll(page.songs, false);
    const mix = pillBtn("Shuffle songs", "", "i-shuffle");
    mix.onclick = () => playAll(page.songs, true);
    actions.append(play, mix);
    hasActions = true;
  }
  if (page.shuffleAlbums?.length) {
    const b = pillBtn("Shuffle albums", "", "i-shuffle");
    b.title = "Every album in a random order, each one played in its own track order. Cmd/Ctrl-click albums first to choose.";
    b.onclick = () => shuffleAlbums(page.shuffleAlbums);
    actions.append(b);
    hasActions = true;
  }
  if (page.newPlaylist) {
    const b = pillBtn("New playlist", "", "i-plus");
    b.onclick = e => {
      menuItem = { kind: "new" };
      fillMenu([["mkLocal", "Local playlist…"], music?.isAuthorized && ["mkApple", "Apple Music playlist…"]]);
      placeMenu(e.clientX, e.clientY);
    };
    actions.append(b);
    hasActions = true;
  }
  if (hasActions) head.appendChild(actions);
  return head;
}

function greetingEl(g) {
  const box = el("div", "page-head");
  const greet = el("div", "greeting");
  if (g.art) {
    const artBox = el("div", "hello-art");
    const img = el("img");
    img.src = g.art;
    img.alt = "";
    artBox.appendChild(img);
    greet.appendChild(artBox);
  }
  const copy = el("div");
  copy.appendChild(el("div", "hello-kicker", g.kicker || ""));
  copy.appendChild(el("h1", "", g.title || ""));
  greet.appendChild(copy);
  box.appendChild(greet);
  return box;
}

function heroEl(hero) {
  const wrap = el("div", "hero");
  const artBox = el("div", "hero-art");
  if (hero.art) {
    const img = el("img");
    img.src = hero.art;
    img.alt = "";
    artBox.appendChild(img);
  } else {
    const fb = el("div", "art-fallback");
    fb.innerHTML = icon("i-music");
    artBox.appendChild(fb);
  }
  const info = el("div", "hero-info");
  if (hero.kicker) info.appendChild(el("div", "hero-kicker", hero.kicker));
  info.appendChild(el("h1", "", hero.title || ""));
  if (hero.artist) info.appendChild(el("div", "hero-artist", hero.artist));
  const meta = (hero.meta || []).filter(Boolean);
  if (meta.length) {
    const row = el("div", "hero-meta");
    meta.forEach(m => row.appendChild(el("span", "", m)));
    info.appendChild(row);
  }
  if (hero.item) {
    const actions = el("div", "hero-actions");
    const play = pillBtn("Play", "primary", "i-play");
    play.onclick = () => run(ACTIONS.play(hero.item));
    const mix = pillBtn("Shuffle", "", "i-shuffle");
    mix.onclick = () => run(ACTIONS.shuffle(hero.item));
    const more = pillBtn("", "icon-only", "i-more");
    more.title = "More";
    more.setAttribute("aria-label", "More");
    more.onclick = e => {
      const entries = menuEntries(hero.item);
      if (!entries.length) return;
      menuItem = hero.item;
      fillMenu(entries);
      placeMenu(e.clientX, e.clientY);
    };
    actions.append(play, mix, more);
    info.appendChild(actions);
  }
  wrap.append(artBox, info);
  return wrap;
}

function emptyEl(e) {
  const box = el("div", "empty-state");
  const circle = el("div", "empty-icon");
  circle.innerHTML = icon(e.icon || "i-music");
  box.appendChild(circle);
  box.appendChild(el("h2", "", e.title || "Nothing here"));
  if (e.text) box.appendChild(el("p", "", e.text));
  if (e.actions?.length) {
    const row = el("div", "button-row");
    for (const [label, action] of e.actions) {
      const b = el("button", "action", label);
      b.type = "button";
      b.onclick = () => {
        if (action === "signIn") {
          connect().then(ok => { if (ok) load(); }).catch(err => status("Couldn't sign in: " + (err?.message || err), true));
        } else localAction(action);
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  return box;
}

function artNode(item, cls, size) {
  const url = itemArt(item, size);
  if (url) {
    const img = el("img", cls);
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    return img;
  }
  const fb = el("div", `${cls} art-fallback`);
  fb.innerHTML = icon(item.kind === "artist" ? "i-users" : item.kind === "station" ? "i-radio" : "i-music");
  return fb;
}

function tagCard(node, item, i) {
  node.dataset.idx = String(i);
  node.dataset.id = item.id;
  if (item.playId) node.dataset.play = item.playId;
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  return node;
}

function songCard(item, i) {
  const card = tagCard(el("div", "song-card"), item, i);
  card.appendChild(artNode(item, "art", 120));
  const meta = el("div", "meta");
  meta.appendChild(el("div", "title", item.title || ""));
  meta.appendChild(el("div", "sub", item.artist || ""));
  card.appendChild(meta);
  if (item.ms) card.appendChild(el("div", "dur", fmt(item.ms / 1000)));
  const actions = el("div", "card-actions");
  actions.append(iconBtn("i-heart", "heart-btn", "Favorite"), iconBtn("i-more", "more", "More"));
  card.appendChild(actions);
  return card;
}

function songGrid(list) {
  const grid = el("div", "song-grid");
  list.forEach(item => grid.appendChild(songCard(item, addItem(item))));
  return grid;
}

function coverCard(item, i) {
  const card = tagCard(el("div", "cover-card"), item, i);
  if (selectedAlbums.has(item.id)) card.classList.add("selected");
  const cover = el("div", "cover");
  cover.appendChild(artNode(item, "", 320));
  const fab = el("span", "play-fab");
  fab.innerHTML = icon("i-play");
  cover.appendChild(fab);
  card.appendChild(cover);
  card.appendChild(el("div", "cc-title", item.title || ""));
  const sub = item.kind === "station" ? "Station" : item.artist || "";
  if (sub) card.appendChild(el("div", "cc-sub", sub));
  return card;
}

function coverGrid(list) {
  const grid = el("div", "cover-grid");
  list.forEach(item => grid.appendChild(coverCard(item, addItem(item))));
  return grid;
}

function coverRow(list) {
  const row = el("div", "cover-row");
  list.forEach(item => row.appendChild(coverCard(item, addItem(item))));
  return row;
}

function artistCard(item, i) {
  const card = tagCard(el("div", "artist-card"), item, i);
  const box = el("div", "artist-art");
  const url = itemArt(item, 320);
  if (url) {
    const img = el("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    box.appendChild(img);
  } else {
    const fb = el("div", "art-fallback");
    fb.innerHTML = icon("i-users");
    box.appendChild(fb);
  }
  card.appendChild(box);
  card.appendChild(el("div", "ac-title", item.title || ""));
  const sub = item.local && item.tracks?.length ? `${item.tracks.length} songs` : "Artist";
  card.appendChild(el("div", "ac-sub", sub));
  return card;
}

function artistGrid(list) {
  const grid = el("div", "artist-grid");
  list.forEach(item => grid.appendChild(artistCard(item, addItem(item))));
  return grid;
}

function trackRow(item, i, n, albumColumn) {
  const row = tagCard(el("div", "track-row"), item, i);
  const idx = el("div", "idx");
  idx.innerHTML = `<span>${item.trackNumber || n}</span>${icon("i-play")}`;
  row.appendChild(idx);
  row.appendChild(artNode(item, "art", 80));
  const meta = el("div", "meta");
  const title = el("div", "title", item.title || "");
  if (item.local && item.format) {
    const badge = el("span", "format", item.format);
    title.appendChild(badge);
  }
  meta.appendChild(title);
  meta.appendChild(el("div", "sub", item.artist || ""));
  row.appendChild(meta);
  const isSong = item.kind === "song";
  const albumText = albumColumn ? item.album || ""
    : item.count ? `${item.count} songs`
    : item.trackCount ? `${item.trackCount} songs`
    : "";
  row.appendChild(el("div", "album", albumText));
  row.appendChild(el("div", "dur", isSong ? (item.ms ? fmt(item.ms / 1000) : "") : item.year || ""));
  row.append(iconBtn("i-heart", "heart-btn", "Favorite"), iconBtn("i-more", "more", "More"));
  return row;
}

function trackList(list, { album = "", showHead = true } = {}) {
  const box = el("div", "track-list");
  if (showHead) {
    const head = el("div", "track-head");
    head.innerHTML = `<span class="num">#</span><span></span><span>Title</span><span class="album">${album ? "Album" : ""}</span><span>${icon("i-clock")}</span><span></span><span></span>`;
    box.appendChild(head);
  }
  list.forEach((item, n) => box.appendChild(trackRow(item, addItem(item), n + 1, album)));
  return box;
}

function listAsRows(list) {
  const box = el("div", "track-list");
  list.forEach((item, n) => box.appendChild(trackRow(item, addItem(item), n + 1, false)));
  return box;
}

function addItem(item) { items.push(item); return items.length - 1; }

function renderSection(sec, root) {
  if (!sec.items?.length) return;
  const section = el("section", "section");
  if (!sec.hideHead) {
    const head = el("div", "section-head");
    head.appendChild(el("h2", "", sec.title));
    if (sec.items.length) head.appendChild(el("span", "count", String(sec.items.length)));
    if (sec.shuffle) {
      const b = el("button", "more", "Shuffle albums");
      b.type = "button";
      b.onclick = () => shuffleAlbums(sec.items);
      head.appendChild(b);
    }
    section.appendChild(head);
  }
  const grid = prefs.layout !== "list";
  if (sec.layout === "row") section.appendChild(coverRow(sec.items));
  else if (sec.layout === "artists") section.appendChild(grid ? artistGrid(sec.items) : listAsRows(sec.items));
  else if (sec.layout === "tracks") section.appendChild(grid ? songGrid(sec.items) : trackList(sec.items, { album: sec.album }));
  else section.appendChild(grid ? coverGrid(sec.items) : listAsRows(sec.items));
  if (sec.note) section.appendChild(el("p", "muted small", sec.note));
  root.appendChild(section);
}

function filterBar(filters) {
  const bar = el("div", "filter-bar");
  for (const [id, label] of filters.items) {
    const b = el("button", "chip" + (id === filters.active ? " on" : ""), label);
    b.type = "button";
    b.onclick = () => {
      if (filters.kind === "local") localFilter = id; else libraryFilter = id;
      load();
    };
    bar.appendChild(b);
  }
  return bar;
}

function scopeBar(active) {
  const bar = el("div", "scope-bar");
  for (const [id, label] of [["all", "All"], ["apple", "Apple Music"], ["files", "Your files"]]) {
    const b = el("button", "chip" + (id === active ? " on" : ""), label);
    b.type = "button";
    b.onclick = () => { searchScope = id; load(); };
    bar.appendChild(b);
  }
  return bar;
}

function renderPage(page) {
  lastPage = page;
  items = [];
  const content = $("content");
  content.innerHTML = "";
  const root = el("div", "view");
  content.appendChild(root);

  if (page.greeting) root.appendChild(greetingEl(page.greeting));
  else if (page.hero) root.appendChild(heroEl(page.hero));
  else if (page.title) root.appendChild(pageHead(page));
  if (page.filters) root.appendChild(filterBar(page.filters));
  if (page.scope) root.appendChild(scopeBar(page.scope));

  for (const sec of page.sections || []) renderSection(sec, root);

  const filled = (page.sections || []).some(s => s.items?.length);
  if (!filled && page.empty) root.appendChild(emptyEl(page.empty));
  else if (!filled && !page.hero && !page.greeting) root.appendChild(emptyEl({ icon: "i-search", title: "Nothing here", text: "Try a different search." }));

  content.scrollTop = 0;
  $("backBtn").hidden = !stack.length;
  markPlaying();
  const note = page.sections?.map(s => s.note).filter(Boolean)[0];
  if (note) status(note);
}

// ---- opening things ----------------------------------------------------------------------------
async function open(item) {
  status("Loading…");
  currentPlaylist = item.local && item.kind === "playlist" ? item.playlist : null;
  const job = ++loadJob;
  try {
    let page;
    if (item.kind === "artist") page = await artistPage(item);
    else if (item.kind === "playlist") page = await playlistPage(item);
    else if (item.kind === "category") page = listPage(item.title, await libraryList(item.id), item.id === "songs" ? "tracks" : "covers", "From your library", item.id === "songs");
    else if (item.local && item.kind === "album") {
      const tracks = await tracksOf(item);
      page = {
        hero: { kicker: "Album · Your files", title: item.title, artist: item.artist, art: itemArt(item, 900), meta: [item.year, `${tracks.length} songs`].filter(Boolean), item },
        songs: tracks,
        sections: [{ title: "Songs", items: tracks, layout: "tracks", hideHead: true, album: item.title }],
      };
    } else if (item.local && item.kind === "artist") {
      const tracks = await tracksOf(item);
      page = {
        hero: { kicker: "Artist · Your files", title: item.title, art: itemArt(item, 900), meta: [`${tracks.length} songs`], item },
        songs: tracks,
        sections: [{ title: "Songs", items: tracks, layout: "tracks", hideHead: true }],
      };
    } else page = await albumPage(item);
    if (job !== loadJob) return;
    if (lastPage) stack.push({ page: lastPage, scroll: $("content").scrollTop });
    renderPage(page);
    status("");
  } catch (e) { status(e?.message || String(e), true); }
}

function back() {
  const prev = stack.pop();
  if (!prev) return;
  renderPage(prev.page);
  $("content").scrollTop = prev.scroll;
  $("backBtn").hidden = !stack.length;
}

async function load() {
  if (view !== "search" && !VIEWS[view]) return;
  currentPlaylist = null;
  stack = [];
  $("backBtn").hidden = true;
  const job = ++loadJob, v = view;
  const q = $("q").value.trim();
  if (v === "search" && !q) {
    renderPage({
      title: "Search", kicker: "Search", scope: searchScope,
      empty: { icon: "i-search", title: "Find something to play", text: "Songs, albums, artists and files, all at once. Paste an album link and it opens straight away." },
    });
    return;
  }
  if (v !== "local") status(v === "search" ? "Searching…" : "Loading…");
  try {
    const page = v === "search" ? await searchPage(q) : await VIEWS[v]();
    if (job !== loadJob) return;
    renderPage(page);
    if (v !== "local") status("");
  } catch (e) {
    if (job !== loadJob) return;
    renderPage({
      title: "That didn't load", kicker: "Orchard",
      empty: { icon: "i-search", title: "That didn't load", text: e?.message || String(e) },
    });
    status((v === "search" ? "Search failed: " : "") + (e?.message || e), true);
  }
}

function setView(v) {
  view = v;
  $$(".nav-item[data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  if (v === "search") $("q").focus();
  clearSelection();
}

$$(".nav-item[data-view]").forEach(b => {
  const label = b.querySelector("span")?.textContent;
  if (label) b.title = label;
  b.onclick = () => {
    if (b.dataset.view === view) { load(); return; }
    setView(b.dataset.view);
    load();
  };
});

// ---- the layout switch -------------------------------------------------------------------------
function setLayout(name) {
  prefs.layout = name === "list" ? "list" : "grid";
  savePrefs();
  $("layoutGrid").classList.toggle("on", prefs.layout === "grid");
  $("layoutList").classList.toggle("on", prefs.layout === "list");
  if (lastPage) renderPage(lastPage);
}
$("layoutGrid").onclick = () => setLayout("grid");
$("layoutList").onclick = () => setLayout("list");
setLayout(prefs.layout);

$("refreshBtn").onclick = () => {
  if (VIEWS[view] || view === "search") load();
  else if (lastPage) renderPage(lastPage);
};

let searchTimer = 0;
$("q").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  clearTimeout(searchTimer);
  if (view !== "search") setView("search");
  load();
});
$("q").addEventListener("input", () => {
  const value = $("q").value;
  $("clearSearch").hidden = !value;
  clearTimeout(searchTimer);
  if (view === "search" || value.trim().length >= 2) {
    if (view !== "search") setView("search");
    searchTimer = setTimeout(load, 280);
  }
});
$("clearSearch").onclick = () => {
  $("q").value = "";
  $("clearSearch").hidden = true;
  $("q").focus();
  if (view === "search") load();
};
$("backBtn").onclick = back;

// ---- local library -----------------------------------------------------------------------------
let local = { roots: [], tracks: [], albums: [], artists: [] };
let localLoaded = false;
const plays = (() => { try { return JSON.parse(localStorage.getItem("glass.plays")) || {}; } catch { return {}; } })();
const savePlays = () => { try { localStorage.setItem("glass.plays", JSON.stringify(plays)); } catch {} };
let recentIds = (() => { try { return JSON.parse(localStorage.getItem("glass.recent")) || []; } catch { return []; } })();
const saveRecent = () => { try { localStorage.setItem("glass.recent", JSON.stringify(recentIds)); } catch {} };
const localFavs = new Set((() => { try { return JSON.parse(localStorage.getItem("glass.favs")) || []; } catch { return []; } })());
const saveFavs = () => { try { localStorage.setItem("glass.favs", JSON.stringify([...localFavs])); } catch {} };
const appleFavs = new Set();

// ---- playlists built by hand (local files) ------------------------------------------------------
let localPlaylists = (() => { try { return JSON.parse(localStorage.getItem("glass.playlists")) || []; } catch { return []; } })();
const saveLocalPlaylists = () => { try { localStorage.setItem("glass.playlists", JSON.stringify(localPlaylists)); } catch {} };
let currentPlaylist = null;

function localPlaylistTracks(pl) {
  return (pl.trackIds || []).map(id => local.tracks.find(t => t.id === id)).filter(Boolean);
}

function localPlaylistItem(pl) {
  const tracks = localPlaylistTracks(pl);
  return {
    kind: "playlist", local: true, id: pl.id, title: pl.name,
    artist: "Playlist · Your files", art: tracks[0]?.art || "", tracks, playlist: pl,
  };
}

function newLocalPlaylist(name) {
  const pl = { id: "pl-" + crypto.randomUUID().slice(0, 8), name: (name || "New playlist").trim(), trackIds: [] };
  localPlaylists.push(pl);
  saveLocalPlaylists();
  return pl;
}

async function addToLocalPlaylist(pl, item) {
  const songs = await tracksOf(item);
  let added = 0;
  for (const t of songs) {
    if (t?.local && !pl.trackIds.includes(t.id)) { pl.trackIds.push(t.id); added++; }
  }
  saveLocalPlaylists();
  return added;
}

const isFavourite = it => !!it && (it.local ? localFavs.has(it.id) : appleFavs.has(String(it.id)));

function countPlay(item) {
  if (!item?.local) return;
  plays[item.id] = (plays[item.id] || 0) + 1;
  savePlays();
  recentIds = [item.id, ...recentIds.filter(id => id !== item.id)].slice(0, 60);
  saveRecent();
}

function applyLocal(state) {
  if (!state) return;
  local = state;
  localLoaded = true;
  const badge = $("localCount");
  badge.textContent = String(local.tracks.length);
  badge.hidden = !local.tracks.length;
  paintLocalSettings();
  if (view === "local" && !stack.length) renderPage(localPage());
}

async function loadLocal(force) {
  if (localLoaded && !force) return local;
  try { applyLocal(await glass.localLibrary()); } catch (e) { status("Couldn't read the local library: " + (e?.message || e), true); }
  return local;
}

async function localAction(name) {
  try {
    let state = null;
    if (name === "addFolder") state = await glass.localAdd("folder");
    else if (name === "addFiles") state = await glass.localAdd("files");
    else if (name === "rescan") { status("Scanning…"); state = await glass.localRescan(); }
    else if (name === "clear") {
      state = await glass.localClear();
      localQueue = [];
      localIndex = -1;
      leaveLocal();
      renderQueue();
      status("Local library cleared.");
    }
    if (state) { applyLocal(state); status(""); }
  } catch (e) { status("Couldn't update the library: " + (e?.message || e), true); }
}

function playLocalList(list, startId) {
  localQueue = list.filter(t => t.local && t.kind === "song");
  if (!localQueue.length) return;
  const at = startId ? localQueue.findIndex(t => t.id === startId) : 0;
  localShuffle = false;
  modes();
  playLocalAt(Math.max(at, 0));
}

async function playAll(list, doShuffle) {
  const songs = list.filter(t => t.kind === "song");
  if (!songs.length) { status("Nothing playable here."); return; }
  const useLocal = songs[0].local;
  const playable = songs.filter(t => !!t.local === useLocal);
  if (!playable.length) { status("Nothing playable here."); return; }
  if (useLocal) {
    localQueue = doShuffle ? shuffled(playable) : [...playable];
    localShuffle = !!doShuffle;
    modes();
    playLocalAt(0);
    status(`Playing ${localQueue.length} song${localQueue.length === 1 ? "" : "s"}`);
    return;
  }
  if (!music) return;
  try {
    music.shuffleMode = 0;
    await startList(doShuffle ? shuffled(playable) : playable);
    shuffleLit = !!doShuffle;
    modes();
    status(`Playing ${playable.length} song${playable.length === 1 ? "" : "s"}`);
  } catch (e) { status("Couldn't play: " + (e?.message || e), true); }
}

function run(promise) {
  promise.then(msg => { if (msg) status(msg); }).catch(e => status("Couldn't do that: " + (e?.message || e), true));
}

// ---- whole-album shuffle and multi-select ------------------------------------------------------
const selectedAlbums = new Map();

function toggleAlbumSelection(item) {
  if (selectedAlbums.has(item.id)) selectedAlbums.delete(item.id); else selectedAlbums.set(item.id, item);
  $$(".cover-card").forEach(card => {
    const it = items[+card.dataset.idx];
    if (it) card.classList.toggle("selected", selectedAlbums.has(it.id));
  });
  updateSelectionBar();
}

function clearSelection() {
  selectedAlbums.clear();
  $$(".cover-card.selected").forEach(c => c.classList.remove("selected"));
  updateSelectionBar();
}

function updateSelectionBar() {
  const bar = $("selectionBar");
  if (!bar) return;
  bar.hidden = selectedAlbums.size === 0;
  $("selectionCount").textContent = `${selectedAlbums.size} album${selectedAlbums.size === 1 ? "" : "s"} selected`;
}

// Whole records, one after another: shuffle the album order, keep every album's own track order.
async function shuffleAlbums(albums) {
  const list = shuffled((albums || []).filter(a => a && a.kind === "album"));
  if (!list.length) { status("No albums to shuffle."); return; }
  status(`Reading ${list.length} album${list.length === 1 ? "" : "s"}…`);
  const songs = [];
  for (let i = 0; i < list.length; i += 4) {
    const batch = await Promise.all(list.slice(i, i + 4).map(a => tracksOf(a).catch(() => [])));
    for (const tracks of batch) songs.push(...tracks);
  }
  if (!songs.length) { status("No playable albums."); return; }
  const localSongs = songs.filter(t => t.local);
  const appleSongs = songs.filter(t => !t.local);
  const useLocal = songs[0].local;
  const playable = useLocal ? localSongs : appleSongs;
  if (!playable.length) { status("No playable albums."); return; }
  if (useLocal) {
    localQueue = playable;
    localShuffle = false;
    localRepeat = 0;
    modes();
    playLocalAt(0);
  } else {
    if (!music) return;
    music.shuffleMode = 0;
    await startList(playable);
    shuffleLit = false;
    modes();
  }
  const mixed = playable.length < songs.length ? ` · ${useLocal ? "files" : "Apple Music"} only` : "";
  status(`Shuffling ${list.length} album${list.length === 1 ? "" : "s"} · ${playable.length} song${playable.length === 1 ? "" : "s"}${mixed}`);
}

$("selectionShuffle").onclick = () => {
  const albums = [...selectedAlbums.values()];
  clearSelection();
  run(shuffleAlbums(albums));
};
$("selectionClear").onclick = clearSelection;

// ---- playing Apple Music -----------------------------------------------------------------------
let queueJob = 0;
const FIRST = 100;

// Queue a list and start it. Long lists start after the first 100 songs and the rest are added
// behind them in the background, so a big shuffle plays in a second or two instead of after all of it loads.
async function startList(songs) {
  leaveLocal();
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

async function playAt(i) {
  const item = items[i];
  if (!item) return;
  if (item.local) { playLocalList(items.filter(t => t.local), item.id); return; }
  if (!music) return;
  if (!music.isAuthorized) {
    status("Sign in to Apple Music in the window that opens…");
    if (!(await connect())) status("Not signed in, playing a 30 second preview.");
  }
  lockQuality();
  const songs = items.filter(t => t.kind === "song" && !t.local);
  const at = songs.findIndex(t => t.id === item.id);
  queueJob++; shuffleLit = false; modes();
  try {
    await music.setQueue({ songs: songs.map(t => t.playId), startWith: Math.max(at, 0), startPlaying: true });
    status("");
  } catch (e) { status("Couldn't play this track: " + (e?.message || e), true); }
}

async function playStation(item) {
  if (!music) return;
  if (!music.isAuthorized && !(await connect())) { status("Sign in (⚙) to play stations."); return; }
  leaveLocal();
  lockQuality();
  try { await music.setQueue({ station: item.id, startPlaying: true }); status(""); }
  catch (e) { status("Couldn't start this station: " + (e?.message || e), true); }
}

const ACTIONS = {
  async play(item) {
    status(`Loading ${item.title}…`);
    const songs = await tracksOf(item);
    if (!songs.length) throw new Error("nothing playable here");
    if (songs[0].local) {
      localQueue = [...songs];
      localShuffle = false;
      modes();
      playLocalAt(0);
      return `Playing ${item.title} · ${songs.length} song${songs.length === 1 ? "" : "s"}`;
    }
    music.shuffleMode = 0;
    await startList(songs);
    return `Playing ${item.title} · ${songs.length} song${songs.length === 1 ? "" : "s"}`;
  },
  async shuffle(item) {
    status(`Shuffling ${item.title}…`);
    const songs = await tracksOf(item);
    if (!songs.length) throw new Error("nothing playable here");
    if (songs[0].local) {
      localQueue = shuffled(songs);
      localShuffle = true;
      modes();
      playLocalAt(0);
      return `Shuffling ${item.title} · ${songs.length} song${songs.length === 1 ? "" : "s"}`;
    }
    music.shuffleMode = 0;
    // The whole list is shuffled here (uniformly, see shuffled()), so the order is already random;
    // the Shuffle button is lit to say so, without asking MusicKit to shuffle it again.
    await startList(shuffled(songs));
    shuffleLit = true; modes();
    return `Shuffling ${item.title} · ${songs.length} song${songs.length === 1 ? "" : "s"}`;
  },
  async next(item) {
    const songs = await tracksOf(item);
    if (!songs.length) throw new Error("nothing playable here");
    if (songs[0].local) {
      if (!localItem()) { localQueue = [...songs]; playLocalAt(0); }
      else if (music?.isPlaying) throw new Error("Apple Music is playing. Play this from the Local Files tab instead.");
      else { localQueue.splice(localIndex + 1, 0, ...songs); renderQueue(); }
      return `Playing next: ${item.title}`;
    }
    if (localItem()) throw new Error("your own files are playing. Play this from Apple Music instead.");
    if (!music.nowPlayingItem) await music.setQueue({ songs: songs.map(t => t.playId), startPlaying: true });
    else await music.playNext({ songs: songs.map(t => t.playId) });
    return `Playing next: ${item.title}`;
  },
  async later(item) {
    const songs = await tracksOf(item);
    if (!songs.length) throw new Error("nothing playable here");
    if (songs[0].local) {
      if (!localItem()) { localQueue = [...songs]; playLocalAt(0); }
      else if (music?.isPlaying) throw new Error("Apple Music is playing. Play this from the Local Files tab instead.");
      else { localQueue.push(...songs); renderQueue(); }
      return `Added to queue: ${item.title}`;
    }
    if (localItem()) throw new Error("your own files are playing. Play this from Apple Music instead.");
    if (!music.nowPlayingItem) await music.setQueue({ songs: songs.map(t => t.playId), startPlaying: true });
    else await music.playLater({ songs: songs.map(t => t.playId) });
    return `Added to queue: ${item.title}`;
  },
  async library(item) {
    if (item.local) return "";
    const id = item.kind === "song" ? item.playId : item.id;
    await amp("POST", `/v1/me/library?ids%5B${item.kind}s%5D=${encodeURIComponent(id)}`);
    libraryArtists = null;                     // suggestions shouldn't offer what was just added
    return `Added to your library: ${item.title}`;
  },
  async open(item) { await open(item); return ""; },
  async review(item) { await openReviewer(item); return ""; },
  async goAlbum(item) {
    const album = item.local
      ? local.albums.find(a => a.albumKey && a.albumKey === item.albumKey)
      : await albumOfSong(item);
    if (!album) throw new Error("couldn't find the album");
    await open(album);
    return "";
  },
  async goArtist(item) {
    const artist = item.local
      ? local.artists.find(a => a.title === (item.albumArtist || item.artist))
      : await artistOfSong(item);
    if (!artist) throw new Error("couldn't find the artist");
    await open(artist);
    return "";
  },
  // New playlists, from Library → Playlists. Local ones live in the app; Apple ones go to the account.
  async mkLocal() {
    const name = prompt("Name for the new playlist");
    if (name == null) return "";
    const pl = newLocalPlaylist(name);
    if (view === "library" && libraryFilter === "playlists") load();
    return `Created “${pl.name}”.`;
  },
  async mkApple() {
    if (!music?.isAuthorized) throw new Error("sign in to Apple Music first");
    const name = prompt("Name for the new Apple Music playlist");
    if (name == null || !name.trim()) return "";
    await createApplePlaylist(name.trim(), []);
    if (view === "library" && libraryFilter === "playlists") load();
    return `Created “${name.trim()}” in your Apple Music library.`;
  },
  async qplay({ li }) { +li.dataset.i === queuePos() ? await seekTo(0) : await changeTo(+li.dataset.i); return ""; },
  async qtop({ li }) { await moveQueued(li, (n, pos) => pos + 1); return ""; },
  async qup({ li }) { await moveQueued(li, +li.dataset.i - 1); return ""; },
  async qdown({ li }) { await moveQueued(li, +li.dataset.i + 1); return ""; },
  async qbottom({ li }) { await moveQueued(li, n => n - 1); return ""; },
  async qremove({ li }) { await removeQueued(li); return ""; },
};

async function addToPlaylist(item, playlist) {
  const songs = await tracksOf(item);
  await amp("POST", `/v1/me/library/playlists/${playlist.id}/tracks`, {
    data: songs.map(t => ({ id: t.playId, type: t.lib || String(t.playId).startsWith("i.") ? "library-songs" : "songs" })),
  });
  return `Added ${item.title} to ${playlist.title}`;
}

// ---- shuffle, repeat, autoplay -----------------------------------------------------------------
$("shuffle").onclick = async () => {
  if (localItem()) {
    localShuffle = !localShuffle;
    if (localShuffle) {
      const cur = localQueue[localIndex];
      localQueue = shuffled(localQueue);
      localIndex = localQueue.indexOf(cur);
    }
    modes(); renderQueue();
    return;
  }
  if (!music?.nowPlayingItem) {
    const mine = items.filter(t => t.local && t.kind === "song");
    if (mine.length) {
      localQueue = shuffled(mine);
      localShuffle = true;
      modes();
      playLocalAt(0);
      status(`Shuffling ${localQueue.length} files`);
      return;
    }
  }
  if (!music) return;
  const songs = items.filter(t => t.kind === "song" && !t.local);
  if (!music.nowPlayingItem && songs.length) {          // nothing playing: shuffle what's on screen
    try { await startList(shuffled(songs)); shuffleLit = true; modes(); status(`Shuffling ${songs.length} songs`); }
    catch (e) { status("Couldn't shuffle: " + (e?.message || e), true); }
    return;
  }
  const on = !(music.shuffleMode || shuffleLit);
  shuffleLit = false;
  music.shuffleMode = on ? 1 : 0;   // MusicKit shuffles what's after the current song (crypto-random, see top)
  modes(); renderQueue();
};

$("repeat").onclick = () => {
  if (localItem()) { localRepeat = { 0: 2, 2: 1, 1: 0 }[localRepeat] ?? 0; modes(); return; }
  if (music) { music.repeatMode = { 0: 2, 2: 1, 1: 0 }[music.repeatMode]; modes(); }
};

$("autoplaySetting").checked = !!prefs.autoplay;
function setAutoplay(on) {
  prefs.autoplay = !!on; savePrefs();
  $("autoplaySetting").checked = prefs.autoplay;
  if (music && "autoplayEnabled" in music) { try { music.autoplayEnabled = prefs.autoplay; } catch {} }
}
$("autoplaySetting").onchange = e => setAutoplay(e.target.checked);
setAutoplay(prefs.autoplay);

// ---- equalizer (local files only: Apple's protected stream can't be routed through Web Audio) ---
const EQ_BANDS = [[60, "lowshelf"], [250, "peaking"], [1000, "peaking"], [4000, "peaking"], [12000, "highshelf"]];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  warm: [4, 2, 0, -1, -2],
  bright: [-2, -1, 0, 3, 5],
  vocal: [-3, 0, 4, 3, 1],
  bass: [7, 4, 0, -1, -1],
};
let audioCtx = null, eqNodes = [];

function ensureEQ() {
  if (audioCtx) { if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {}); return; }
  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(localAudio);
    eqNodes = EQ_BANDS.map(([f, type]) => {
      const n = audioCtx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = 1.1;
      n.gain.value = 0;
      return n;
    });
    source.connect(eqNodes[0]);
    for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1]);
    eqNodes[eqNodes.length - 1].connect(audioCtx.destination);
    applyEQ();
  } catch (e) { console.warn("[Orchard] No equalizer:", e.message); }
}

function applyEQ() {
  const gains = prefs.eq.on ? prefs.eq.bands : [0, 0, 0, 0, 0];
  eqNodes.forEach((n, i) => { try { n.gain.value = gains[i] || 0; } catch {} });
  const local = !!localItem();
  $("paneEq").classList.toggle("disabled", !local);
  $("eqOn").checked = !!prefs.eq.on;
  $("eqSub").textContent = local ? "Five bands for local files" : "Plays through your own files";
  $$("#eqBands input[data-eq]").forEach(input => {
    const i = EQ_BANDS.findIndex(([f]) => String(f) === input.dataset.eq);
    input.value = String(prefs.eq.bands[i] ?? 0);
    const out = document.querySelector(`[data-eq-val="${input.dataset.eq}"]`);
    if (out) out.textContent = String(prefs.eq.bands[i] ?? 0);
  });
  $$("#eqPresets [data-eq-preset]").forEach(b => b.classList.toggle("on", b.dataset.eqPreset === prefs.eq.preset));
}

$("eqOn").onchange = e => {
  prefs.eq.on = e.target.checked;
  savePrefs();
  ensureEQ();
  applyEQ();
};
$$("#eqPresets [data-eq-preset]").forEach(b => b.onclick = () => {
  const preset = b.dataset.eqPreset;
  prefs.eq.preset = preset;
  prefs.eq.bands = [...(EQ_PRESETS[preset] || EQ_PRESETS.flat)];
  prefs.eq.on = true;
  savePrefs();
  ensureEQ();
  applyEQ();
});
$$("#eqBands input[data-eq]").forEach(input => input.addEventListener("input", () => {
  const i = EQ_BANDS.findIndex(([f]) => String(f) === input.dataset.eq);
  prefs.eq.bands[i] = +input.value;
  prefs.eq.preset = "";
  savePrefs();
  ensureEQ();
  applyEQ();
}));
applyEQ();

// ---- suggested music (daily playlist from Last.fm recommendations) ------------------------------
// Last.fm's API suggests similar artists and a couple of records each; the main process matches them on
// Apple Music. Here they are turned into ordinary items (toItem) so covers, playback and menus all work,
// and the songs become a real Apple Music playlist, replaced when a new day's set is built.
const SUGGESTED_NAME = "Suggested Music";
// Bump when the way suggestions are picked changes, so yesterday's playlist isn't kept just because its date
// matches: the next launch rebuilds it with the new choice.
const SUGGESTED_VERSION = 2;
let suggestedCache = null;                 // { day, user, data } so Create doesn't fetch everything twice

// The local date, not UTC: a "daily" playlist should change at the user's midnight, not mid-afternoon.
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// What is typed in Settings wins over what was saved last time, so Refresh after editing the username uses it.
const suggestedUser = () => ($("lfmUser").value || "").trim() || prefs.lastfmUser || "";

// Artists already in the Apple library, so Last.fm's suggestions don't include what you already have. Read
// once per session; adding something to the library clears it.
let libraryArtists = null;
async function knownArtists() {
  if (libraryArtists) return libraryArtists;
  try { libraryArtists = (await libraryList("artists")).map(a => a.title).filter(Boolean); }
  catch { libraryArtists = []; }
  return libraryArtists;
}

async function suggestedData({ fresh = false } = {}) {
  const day = todayKey(), user = suggestedUser();
  if (!fresh && suggestedCache?.day === day && suggestedCache.user === user) return suggestedCache.data;
  await glass.lastfmAuth().catch(() => null);   // finishes a Last.fm approval that arrived late
  const known = await knownArtists();
  const r = await glass.lastfmSuggested({ user, known, fresh });
  if (r?.error) throw new Error(r.error);
  suggestedCache = { day, user, data: r };
  return r;
}

function suggestedItems(data) {
  const albums = (data.albums || []).filter(a => a.found && a.apple).map(a => toItem(a.apple)).filter(Boolean);
  const artists = (data.artists || []).filter(a => a.found && a.apple).map(a => toItem(a.apple)).filter(Boolean);
  const songs = (data.tracks || []).map(t => toItem(t)).filter(Boolean);
  return { albums, artists, songs };
}

async function suggestedPage() {
  if (!music?.isAuthorized) {
    return {
      title: SUGGESTED_NAME,
      sub: "Sign in to Apple Music to see recommendations",
      sections: [],
      empty: {
        icon: "i-music", title: "Sign in for Apple Music",
        text: "Suggested Music reads your Last.fm listening and finds the artists on Apple Music. Sign in with the Account button first.",
        actions: [["Connect", "signIn"]],
      },
    };
  }
  try {
    status("Reading Last.fm and finding the artists on Apple Music…");
    const { albums, artists, songs } = suggestedItems(await suggestedData());
    const sections = [];
    if (artists.length) sections.push({ title: "Artists to try", items: artists, layout: "artists" });
    if (albums.length) sections.push({ title: "Albums to try", items: albums, layout: "covers" });
    if (songs.length) sections.push({ title: "In the playlist", items: songs, layout: "tracks" });
    status("");
    if (!sections.length) {
      return {
        title: SUGGESTED_NAME,
        sub: "Nothing matched this time",
        sections: [],
        empty: {
          icon: "i-music", title: "Nothing matched on Apple Music",
          text: "Last.fm answered, but none of it was found in the Apple catalogue. Try again later, or add your Last.fm username in Settings.",
        },
      };
    }
    const who = suggestedUser();
    return {
      title: SUGGESTED_NAME,
      sub: who ? `Artists near the ones ${who} plays · ${todayKey()}` : `From the Last.fm charts · ${todayKey()}`,
      sections,
      songs,
    };
  } catch (e) {
    status("");
    const noKey = /API key/i.test(e?.message || "");
    return {
      title: SUGGESTED_NAME,
      sub: "Couldn't read Last.fm",
      sections: [],
      empty: {
        icon: "i-music", title: noKey ? "Last.fm API key needed" : "Couldn't read Last.fm",
        text: noKey ? "Save your free Last.fm API key in Settings, then come back." : (e?.message || String(e)),
      },
    };
  }
}

// Creates the playlist in the user's Apple Music library, then removes older copies. Apple answers with the
// new playlist's library id, which is remembered so the next day knows what to delete.
const SUGGESTED_MARK = "Last.fm suggestions for ";

// Apple's create reply and its library listing do not always agree on the "p." prefix on a playlist id, and
// a mismatch used to make the cleanup delete the playlist that had just been made.
const sameId = (a, b) => String(a || "").replace(/^p\./, "") === String(b || "").replace(/^p\./, "");

async function libraryPlaylists() {
  try { return (await amp("GET", "/v1/me/library/playlists?limit=100"))?.data || null; }
  catch { return null; }
}

// Yesterday's copy, and any left behind if the saved settings were lost. Only playlists carrying our own
// description are removed, so a playlist of the user's that happens to share the name is left alone.
async function removeOldSuggested(keepId) {
  const list = await libraryPlaylists();
  for (const p of list || []) {
    const a = p.attributes || {};
    if (sameId(p.id, keepId) || a.name !== SUGGESTED_NAME) continue;
    if (!String(a.description || "").startsWith(SUGGESTED_MARK)) continue;
    try { await amp("DELETE", `/v1/me/library/playlists/${p.id}`); } catch {}
  }
}

// Creates a playlist in the user's Apple Music library and fills it, in batches of 100. If filling fails the
// half-made playlist is removed, so a retry doesn't leave a trail of empty ones.
async function createApplePlaylist(name, songs, description = "") {
  const created = await amp("POST", "/v1/me/library/playlists", {
    attributes: { name, ...(description ? { description } : {}) },
  });
  const id = created?.data?.[0]?.id;
  if (!id) throw new Error("Apple Music didn't return the new playlist.");
  try {
    for (let i = 0; i < songs.length; i += 100) {
      await amp("POST", `/v1/me/library/playlists/${id}/tracks`, {
        data: songs.slice(i, i + 100).map(s => ({ id: s.playId, type: "songs" })),
      });
    }
  } catch (e) {
    try { await amp("DELETE", `/v1/me/library/playlists/${id}`); } catch {}
    throw e;
  }
  return id;
}

async function buildSuggestedPlaylist(data) {
  const songs = (data.tracks || []).map(t => toItem(t)).filter(t => t?.kind === "song" && t.playId);
  if (!songs.length) throw new Error("No suggested songs were found on Apple Music.");
  const id = await createApplePlaylist(SUGGESTED_NAME, songs, `${SUGGESTED_MARK}${todayKey()}`);
  const previous = prefs.suggestedPlaylist?.id;
  if (previous && !sameId(previous, id)) {
    try { await amp("DELETE", `/v1/me/library/playlists/${previous}`); } catch {}
  }
  await removeOldSuggested(id);
  // Apple accepts a playlist before it shows up in the library listing; say so rather than leave the user
  // wondering whether it was made at all.
  const listed = await libraryPlaylists();
  const pending = !!listed && !listed.some(p => sameId(p.id, id));
  prefs.suggestedPlaylist = { id, day: todayKey(), songs: songs.length, version: SUGGESTED_VERSION };
  savePrefs();
  return { id, songs, pending };
}

const suggestNote = text => { $("suggestStatus").textContent = text; };

$("suggestCreateBtn").onclick = async () => {
  const b = $("suggestCreateBtn");
  if (!music?.isAuthorized) { suggestNote("Sign in to Apple Music first (Account)."); return; }
  b.disabled = true;
  suggestNote("Building the playlist…");
  try {
    const { songs, pending } = await buildSuggestedPlaylist(await suggestedData({ fresh: true }));
    suggestNote(pending
      ? `Created “${SUGGESTED_NAME}” with ${songs.length} songs. Apple hasn't listed it in your library yet; it can take a moment to sync.`
      : `Created “${SUGGESTED_NAME}” with ${songs.length} song${songs.length === 1 ? "" : "s"}.`);
    if (view === "suggested") load();
    if (view === "library" && libraryFilter === "playlists") load();
  } catch (e) {
    suggestNote("Couldn't create the playlist: " + String(e?.message || e).replace(/^.*Error: /, ""));
  }
  b.disabled = false;
};

$("suggestRefreshBtn").onclick = async () => {
  if (!music?.isAuthorized) { suggestNote("Sign in to Apple Music first (Account)."); return; }
  const b = $("suggestRefreshBtn");
  b.disabled = true;
  suggestNote("Asking Last.fm again…");
  try {
    const data = await suggestedData({ fresh: true });
    const { albums, artists } = suggestedItems(data);
    suggestNote(`${artists.length} artists and ${albums.length} albums matched on Apple Music.`);
    if (view === "suggested") load();
  } catch (e) {
    suggestNote("Couldn't refresh: " + String(e?.message || e).replace(/^.*Error: /, ""));
  }
  b.disabled = false;
};

$("autoSuggestedPlaylist").checked = !!prefs.autoSuggestedPlaylist;
$("autoSuggestedPlaylist").onchange = e => { prefs.autoSuggestedPlaylist = e.target.checked; savePrefs(); };

// ---- import from Spotify -------------------------------------------------------------------------
// The playlist is read from Spotify's public embed page, each track is matched on Apple Music, and the
// matches become a new Apple Music playlist with the Spotify playlist's name. A client id and secret switch
// the read to the Web API, which has no 50-track limit.
function paintSpotifyCreds(st) {
  $("spotifyCreds").textContent = st?.hasId && st?.hasSecret
    ? "Client id saved: imports read the whole playlist."
    : st?.hasId || st?.hasSecret
      ? "Only half saved: imports stop at Spotify's public 50 tracks until both are in."
      : "No client id: imports stop at Spotify's public 50 tracks.";
}
async function showSpotifyCreds() {
  try { paintSpotifyCreds(await glass.spotifyStatus()); } catch {}
}
$("spotifyKeySave").onclick = async () => {
  const st = await glass.setSpotifyKey({ id: $("spotifyId").value, secret: $("spotifySecret").value });
  $("spotifyId").value = $("spotifySecret").value = "";
  paintSpotifyCreds(st);
};
showSpotifyCreds();

$("spotifyImport").onclick = async () => {
  const b = $("spotifyImport"), note = $("spotifyStatus");
  if (!music?.isAuthorized) { note.textContent = "Sign in to Apple Music first (Account)."; return; }
  const url = $("spotifyUrl").value.trim();
  if (!url) { note.textContent = "Paste a Spotify playlist link first."; return; }
  b.disabled = true;
  note.textContent = "Reading the playlist and finding the songs on Apple Music…";
  $("spotifyMissing").textContent = "";
  try {
    const r = await glass.spotifyImport({ url });
    if (r?.error) throw new Error(r.error);
    const songs = (r.tracks || []).map(t => toItem(t)).filter(t => t?.kind === "song" && t.playId);
    if (!songs.length) throw new Error("none of those tracks were found on Apple Music");
    const name = (r.name || "Spotify playlist").trim();
    await createApplePlaylist(name, songs);
    $("spotifyMissing").textContent = (r.missing || []).join("\n");
    const left = r.missing?.length ? ` ${r.missing.length} not found.` : "";
    const cut = r.partial ? " Spotify's public page lists the first 50 tracks." : "";
    note.textContent = `Imported ${songs.length} of ${r.total} songs into “${name}”.${left}${cut}`;
    if (view === "library" && libraryFilter === "playlists") load();
  } catch (e) {
    note.textContent = "Couldn't import: " + String(e?.message || e).replace(/^.*Error: /, "");
  }
  b.disabled = false;
};

// Once a day, when the app opens: rebuild the playlist if the toggle is on and today's copy isn't there.
// One attempt a day is enough; a failure is reported in Settings, where the buttons still retry on demand.
let autoSuggestedBusy = false;
async function maybeAutoCreateSuggested() {
  if (!prefs.autoSuggestedPlaylist || autoSuggestedBusy || !music?.isAuthorized) return;
  const day = todayKey();
  const done = prefs.suggestedPlaylist?.day === day && prefs.suggestedPlaylist?.version === SUGGESTED_VERSION;
  const tried = prefs.suggestedAttempt?.day === day && prefs.suggestedAttempt?.version === SUGGESTED_VERSION;
  if (done || tried) return;
  prefs.suggestedAttempt = { day, version: SUGGESTED_VERSION };
  savePrefs();
  autoSuggestedBusy = true;
  try {
    const { songs } = await buildSuggestedPlaylist(await suggestedData({ fresh: true }));
    suggestNote(`Today's playlist is ready: ${songs.length} songs.`);
  } catch (e) {
    suggestNote("Couldn't build today's playlist: " + String(e?.message || e).replace(/^.*Error: /, ""));
  }
  autoSuggestedBusy = false;
}

// ---- playlist reviewer ---------------------------------------------------------------------------
// Right-click a playlist (or use its "…" menu) and go through it a song at a time: keep it or remove it.
// The decisions live in ui/review.js; this is the card, the two buttons and the keys.
let review = null;

async function removeFromPlaylist(item, song) {
  if (item.local) {
    const pl = item.playlist || localPlaylists.find(p => p.id === item.id);
    if (!pl) throw new Error("playlist not found");
    pl.trackIds = (pl.trackIds || []).filter(id => id !== song.id);
    saveLocalPlaylists();
    return;
  }
  if (!item.canEdit) throw new Error("this playlist can't be edited");
  await amp("DELETE", `/v1/me/library/playlists/${item.id}/tracks/${song.id}`);
}

function paintReview() {
  if (!review) return;
  const run = review.run;
  $("reviewCount").textContent = run.done ? `${run.total} reviewed` : `${run.index + 1} of ${run.total}`;
  $("reviewReject").hidden = $("reviewKeep").hidden = run.done;
  $("reviewCard").hidden = run.done;
  $("reviewDone").hidden = !run.done;
  if (run.done) {
    $("reviewSummary").textContent = `${run.kept} kept · ${run.rejected} removed`;
    return;
  }
  const song = run.current;
  $("reviewSong").textContent = song.title || "";
  $("reviewArtist").textContent = song.artist || "";
  $("reviewAlbum").textContent = song.album || "";
  const art = $("reviewArt");
  art.innerHTML = "";
  art.appendChild(artNode(song, "review-cover", 600));
}

async function openReviewer(item) {
  try {
    status("Loading the playlist…");
    const songs = await tracksOf(item);
    status("");
    if (!songs.length) throw new Error("this playlist is empty");
    review = { item, songs, run: OrchardReview.createReviewer(songs), busy: false, local: !!songs[0].local };
    $("reviewTitle").textContent = item.title || "Playlist";
    $("reviewer").hidden = false;
    paintReview();
    await startReviewAudio();
  } catch (e) { status("Couldn't review that playlist: " + (e?.message || e), true); }
}

// The song on the card is the song you hear. Apple's queue is set once with the whole playlist, so moving on
// is a queue change rather than a new request; local files are just the local queue.
async function startReviewAudio() {
  if (!review) return;
  if (review.local) {
    localQueue = [...review.songs];
    localShuffle = false;
    modes();
    playLocalAt(0);
    return;
  }
  if (!music) return;
  try {
    leaveLocal();
    music.shuffleMode = 0;
    await music.setQueue({ songs: review.songs.map(s => s.playId), startWith: 0, startPlaying: true });
  } catch (e) { status("Couldn't play the first song: " + (e?.message || e), true); }
}

async function playReviewCurrent() {
  if (!review) return;
  const i = review.run.index;
  if (review.run.done) { pauseReviewAudio(); return; }
  if (review.local) playLocalAt(i);
  else changeTo(i);          // the queue is the whole playlist, so this is a jump, not a new request
}

function pauseReviewAudio() {
  if (!review) return;
  if (review.local) localAudio.pause();
  else if (music?.isPlaying) music.pause();
}

async function closeReviewer() {
  if (!review) return;
  const item = review.item;
  pauseReviewAudio();
  review = null;
  $("reviewer").hidden = true;
  if (lastPage?.hero?.item?.id === item.id) {          // the page on screen is the playlist that changed
    try { renderPage(await playlistPage(item)); } catch {}
  }
}

async function decideReview(keep) {
  if (!review || review.busy || review.run.done) return;
  review.busy = true;
  const card = $("reviewCard");
  try {
    if (!keep) await removeFromPlaylist(review.item, review.run.current);   // only advance once it's gone
    card.classList.add(keep ? "leaving-right" : "leaving-left");
    await new Promise(done => setTimeout(done, 170));
    card.classList.remove("leaving-right", "leaving-left");
    keep ? review.run.keep() : review.run.reject();
    paintReview();
    await playReviewCurrent();
  } catch (e) {
    status("Couldn't remove that song: " + (e?.message || e), true);
  }
  review.busy = false;
}

$("reviewKeep").onclick = () => decideReview(true);
$("reviewReject").onclick = () => decideReview(false);
$("reviewClose").onclick = closeReviewer;
$("reviewFinish").onclick = closeReviewer;

// ---- the queue ---------------------------------------------------------------------------------
// Up Next can be rearranged by dragging, a song removed with its × (or the right-click menu), and the lot
// cleared with Clear (click twice). The song that's playing is never touched, so playback carries on.
// Local files use the same plans, applied to a plain array instead of MusicKit's queue.
let clearArmed = 0, clearArmedAt = 0, clearTimer = 0, dragFrom = -1, queueEdits = Promise.resolve();

const queuePos = () => (localItem() ? localIndex : (music?.nowPlayingItemIndex ?? music?.queue?.position ?? 0));
const queueRow = li => [+li.dataset.i, li.dataset.id];
const queueTitle = it => (it.local ? it.title : it.title || it.attributes?.name || "");
const queueArtist = it => (it.local ? it.artist : it.artistName || it.attributes?.artistName || "");
const queueDur = it => (it.local ? it.ms : it.playbackDuration || it.attributes?.durationInMillis || 0);
const queueArt = (it, size) => (it.local ? it.art || "" : art(it.attributes?.artwork || it.artwork, size));

function renderQueue() {
  if (pane !== "queue" || dragFrom >= 0) return;   // redrawn when the drag ends
  const ul = $("queue");
  const list = localItem() ? localQueue : (music?.queue?.items || []);
  const pos = queuePos();
  const upNext = Math.max(0, list.length - pos - 1);
  ul.innerHTML = "";

  const clear = $("queueClear");
  clear.textContent = clearArmed > Date.now() ? "Clear Up Next?" : "Clear Up Next";
  clear.classList.toggle("armed", clearArmed > Date.now());
  clear.disabled = !upNext;
  $("queueSub").textContent = !list.length
    ? "What's playing and what's next"
    : `${upNext} ${localItem() ? "file" : "song"}${upNext === 1 ? "" : "s"} after this one`;

  if (!list.length) {
    ul.appendChild(el("li", "queue-empty", localItem() ? "Nothing queued. Play a file from Local Files." : "The queue is empty. Play something to fill it."));
    return;
  }

  const head = text => { const li = el("li", "head"); li.appendChild(el("span", "", text)); ul.appendChild(li); return li; };
  const start = Math.max(0, pos - 3);
  list.slice(start, pos + 300).forEach((it, k) => {
    const i = start + k;
    if (i === start && i < pos) head("Earlier");
    if (i === pos) head("Now Playing");
    if (i === pos + 1) head(`Up Next · ${upNext} ${localItem() ? "file" : "song"}${upNext === 1 ? "" : "s"}`);
    const li = el("li");
    li.dataset.i = String(i);
    li.dataset.id = it.id;
    if (i === pos) li.classList.add("on");
    else if (i < pos) li.classList.add("past");
    else li.draggable = true;

    const url = queueArt(it, 80);
    if (url) { const img = el("img"); img.alt = ""; img.src = url; li.appendChild(img); }
    else { const fb = el("div", "art-fallback"); fb.innerHTML = icon("i-music"); li.appendChild(fb); }

    const copy = el("div");
    copy.append(el("div", "t", queueTitle(it)), el("div", "a", queueArtist(it)));
    li.appendChild(copy);
    const ms = queueDur(it);
    li.appendChild(el("div", "d", ms ? fmt(ms / 1000) : ""));
    if (i !== pos) {
      const x = el("button", "x");
      x.type = "button";
      x.title = "Remove from Queue";
      x.setAttribute("aria-label", "Remove from Queue");
      x.innerHTML = icon("i-close");
      li.appendChild(x);
    } else li.appendChild(el("span"));
    ul.appendChild(li);
  });
}

function editQueue(plan, check, done) {
  if (localItem()) {
    if (check && localQueue[check[0]]?.id !== check[1]) { status("The queue changed, try again.", true); return Promise.resolve(); }
    const pos = localIndex, n = localQueue.length;
    const order = plan(n, pos);
    if (order) {
      const cur = localQueue[pos];
      localQueue = order.map(i => localQueue[i]);
      localIndex = localQueue.indexOf(cur);
      if (done) status(done);
    }
    renderQueue();
    markPlaying();
    return Promise.resolve();
  }
  queueEdits = queueEdits.then(async () => {
    if (!music) return;
    try { if (await QueueEdit.apply(music, plan, check) && done) status(done); }
    catch (e) { status("Couldn't change the queue: " + (e?.message || e), true); }
    renderQueue();
  });
  return queueEdits;
}

const removeQueued = li => editQueue((n, pos) => QueueEdit.remove(n, pos, +li.dataset.i), queueRow(li), "Removed from the queue");
const moveQueued = (li, to) => editQueue((n, pos) => QueueEdit.move(n, pos, +li.dataset.i, typeof to === "function" ? to(n, pos) : to), queueRow(li));

function clearQueue() {
  clearArmed = 0; clearTimeout(clearTimer);
  if (!localItem()) queueJob++;   // stop a long list that's still being added in the background
  editQueue((n, pos) => QueueEdit.clear(n, pos), null, "Cleared Up Next");
  renderQueue();
}

$("queueClear").onclick = () => {
  if (clearArmed > Date.now()) {
    if (Date.now() - clearArmedAt < 600) return;   // the second half of a double-click must not confirm
    clearQueue();
    return;
  }
  clearArmedAt = Date.now();
  clearArmed = clearArmedAt + 3000;
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => { clearArmed = 0; renderQueue(); }, 3000);
  renderQueue();
};

$("queue").addEventListener("click", e => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  if (e.target.closest(".x")) { removeQueued(li); return; }
  changeTo(+li.dataset.i);
});

function changeTo(i) {
  if (localItem()) { playLocalAt(i); return; }
  music?.changeToMediaAtIndex(i);
}

// drag and drop within Up Next
const dropMarks = () => $$("#queue .drop-before, #queue .drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"));
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
  const r = li.getBoundingClientRect();
  const after = li.classList.contains("on") || e.clientY > r.top + r.height / 2;
  dropMarks();
  li.classList.add(after ? "drop-after" : "drop-before");
});
$("queue").addEventListener("drop", e => {
  const li = e.target.closest("li[data-i]"), from = $("queue").querySelector(`li[data-i="${dragFrom}"]`);
  dropMarks();
  if (dragFrom < 0 || !li || !from) return;
  e.preventDefault();
  const target = +li.dataset.i;
  const r = li.getBoundingClientRect();
  const after = li.classList.contains("on") || e.clientY > r.top + r.height / 2;
  dragFrom = -1;   // so the edit's redraw isn't held back
  moveQueued(from, (n, pos) => QueueEdit.dropIndex(pos, +from.dataset.i, target, after));
});
$("queue").addEventListener("dragend", () => {
  dragFrom = -1;
  dropMarks();
  renderQueue();
});

// right-click a queued song
$("queue").addEventListener("contextmenu", e => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  e.preventDefault();
  const i = +li.dataset.i, pos = queuePos(), last = (localItem() ? localQueue.length : music?.queue?.items?.length || 0) - 1;
  menuItem = { kind: "queued", li };
  fillMenu(i === pos ? [["qplay", "Play from Start"]] : [
    ["qplay", "Play Now"], "-",
    i > pos + 1 && ["qtop", "Move to Top"], i > pos + 1 && ["qup", "Move Up"],
    i < last && ["qdown", "Move Down"], i < last && ["qbottom", "Move to Bottom"], "-",
    ["qremove", "Remove from Queue"],
  ]);
  placeMenu(e.clientX, e.clientY);
});

// ---- lyrics ------------------------------------------------------------------------------------
let lyr = null, lyrFor = null, lyrIdx = -2, userScrollUntil = 0;

function lyricsMessage(text) {
  lyr = null;
  $("lyrics").className = "";
  $("lyrics").innerHTML = "";
  $("lyrics").appendChild(el("div", "empty", text));
  if (stageOpen) {
    const box = $("stageLyrics");
    box.className = "";
    box.innerHTML = "";
    box.appendChild(el("div", "empty", text));
  }
}

async function localLyrics(item) {
  let text = "";
  try { text = await glass.localLyrics(item.path); } catch {}
  if (text?.trim()) {
    const parsed = Lyrics.parseLRC(text);
    if (parsed.lines.length) {
      if (parsed.synced) parsed.lines = Lyrics.withRests(parsed.lines);
      return { ...parsed, source: "File lyrics" };
    }
  }
  const ext = await glass.lyrics({
    artist: item.artist || "", title: item.title || "", album: item.album || "",
    duration: (item.ms || 0) / 1000, wordSync: prefs.wordSync,
  });
  if (!ext) return null;
  const parsed = Lyrics.parseLRC(ext.text);
  if (!parsed.lines.length) return null;
  if (parsed.synced) parsed.lines = Lyrics.withRests(parsed.lines);
  return { ...parsed, source: ext.source };
}

async function loadLyrics(force) {
  const it = nowItem();
  if (!it) { lyrFor = null; lyricsMessage("Play a song to see its lyrics."); $("lyricsSource").textContent = ""; return; }
  const key = it.id + (prefs.wordSync ? ":w" : ":l");
  if (lyrFor === key && !force) return;
  lyrFor = key;
  lyricsMessage("Looking for lyrics…");
  $("lyricsSource").textContent = "";
  let found = null;
  try {
    found = it.local ? await localLyrics(it) : await Lyrics.find(music, music.nowPlayingItem, { wordSync: prefs.wordSync });
  } catch {}
  if (lyrFor !== key) return;                       // the song changed while we were looking
  if (!found?.lines?.length) {
    lyricsMessage(it.local ? "No lyrics for this file, and nothing was found online." : "No lyrics for this song.");
    return;
  }
  lyr = found;
  renderLyrics();
  if (stageOpen) renderStage();
}

function wordSpans(parent, words) {
  words.forEach((w, i) => {
    const span = el("span", "w", w.text);
    parent.appendChild(span);
    if (!w.join && i < words.length - 1) parent.appendChild(document.createTextNode(" "));
  });
}

function renderLyrics() {
  const box = $("lyrics");
  box.innerHTML = "";
  box.className = lyr.synced ? "" : "plain";
  lyr.lines.forEach((line, i) => {
    const node = el("div", "ly" + (line.agent === "v2" ? " v2" : "") + (line.rest ? " rest" : ""));
    node.dataset.i = String(i);
    if (line.rest) node.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>';
    else if (line.words.length) wordSpans(node, line.words);
    else node.textContent = line.text;
    if (line.bg?.length) {
      const bg = el("span", "bgv");
      wordSpans(bg, line.bg);
      node.appendChild(bg);
    }
    box.appendChild(node);
  });
  const how = !lyr.synced ? "not synced" : lyr.worded && prefs.wordSync ? "word-synced" : "line-synced";
  $("lyricsSource").textContent = `${lyr.source} · ${how}`;
  lyrIdx = -2;
  box.scrollTop = 0;
}

// Runs every frame while the lyrics are on screen.
function tick() {
  raf = requestAnimationFrame(tick);
  if (!lyr?.synced) return;
  const t = currentTime() + prefs.nudge;
  const lines = lyr.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].start != null && lines[i].start <= t + 0.05) idx = i; else break; }
  const box = $("lyrics"), nodes = box.children;

  if (idx !== lyrIdx) {
    lyrIdx = idx;
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.abs(i - idx);
      nodes[i].classList.toggle("on", i === idx);
      nodes[i].classList.toggle("past", i < idx);
      nodes[i].style.setProperty("--blur", `${Math.min(d * 0.6, 2.4)}px`);
      nodes[i].style.setProperty("--op", `${Math.max(1 - d * 0.13, 0.35)}`);
      if (i !== idx) nodes[i].querySelectorAll(".w").forEach(w => { w.style.removeProperty("--p"); w.classList.remove("sung"); });
    }
    const cur = nodes[Math.max(idx, 0)];
    if (cur && Date.now() > userScrollUntil)
      box.scrollTo({ top: cur.offsetTop - box.clientHeight * 0.36, behavior: "smooth" });
  }

  const line = lines[idx], node = nodes[idx];
  if (!line || !node) return;
  if (line.rest) {                                   // three dots that fill in through the break
    const g = clamp((t - line.rest[0]) / (line.rest[1] - line.rest[0]), 0, 1);
    node.querySelectorAll(".dots i").forEach((dot, k) => dot.style.setProperty("--g", Math.min(Math.max(g * 3 - k, 0), 1)));
    return;
  }
  if (!prefs.wordSync) return;
  const fillWords = (words, spans, lineEnd) => words.forEach((w, k) => {
    const end = w.end ?? words[k + 1]?.start ?? lineEnd ?? w.start + 0.55;
    const p = clamp((t - w.start) / Math.max(end - w.start, 0.05), 0, 1) * 100;
    spans[k]?.style.setProperty("--p", p.toFixed(1));
    spans[k]?.classList.toggle("sung", p > 0);
  });
  node._spans ??= [...node.querySelectorAll(":scope > .w")];
  fillWords(line.words, node._spans, line.end);
  if (line.bg?.length) fillWords(line.bg, node._bgSpans ??= [...node.querySelectorAll(".bgv .w")], line.end);
}

$("lyrics").addEventListener("wheel", () => { userScrollUntil = Date.now() + 3500; }, { passive: true });
$("lyrics").addEventListener("click", e => {
  const node = e.target.closest(".ly");
  const line = node && lyr?.synced && lyr.lines[+node.dataset.i];
  if (!line || line.rest || line.start == null) return;
  userScrollUntil = 0;
  seekTo(Math.max(0, line.start - prefs.nudge + 0.01));
});

function showNudge() { $("nudgeVal").textContent = `${prefs.nudge > 0 ? "+" : ""}${prefs.nudge.toFixed(1)} s`; }
const nudge = d => {
  prefs.nudge = Math.round(clamp(prefs.nudge + d, -5, 5) * 10) / 10;
  savePrefs();
  showNudge();
  lyrIdx = -2;
};
$("nudgeLess").onclick = () => nudge(-0.1);
$("nudgeMore").onclick = () => nudge(0.1);
showNudge();

// ---- full-screen lyrics stage -------------------------------------------------------------------
let stageOpen = false, stageRaf = 0, stageIdx = -2, stageScrollUntil = 0;

function renderStage() {
  const box = $("stageLyrics");
  box.innerHTML = "";
  box.className = lyr?.synced ? "" : "plain";
  if (!lyr?.lines?.length) {
    box.appendChild(el("div", "empty", lyr ? "These lyrics are not timed." : "No lyrics for this song."));
    return;
  }
  lyr.lines.forEach((line, i) => {
    const node = el("div", "ly" + (line.rest ? " rest" : ""));
    node.dataset.i = String(i);
    if (line.rest) node.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>';
    else if (line.words.length) wordSpans(node, line.words);
    else node.textContent = line.text;
    if (line.bg?.length) {
      const bg = el("span", "bgv");
      wordSpans(bg, line.bg);
      node.appendChild(bg);
    }
    box.appendChild(node);
  });
  stageIdx = -2;
  box.scrollTop = 0;
}

function stageTick() {
  stageRaf = requestAnimationFrame(stageTick);
  if (!lyr?.synced) return;
  const t = currentTime() + prefs.nudge;
  const lines = lyr.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].start != null && lines[i].start <= t + 0.05) idx = i; else break; }
  const box = $("stageLyrics"), nodes = box.children;
  if (idx !== stageIdx) {
    stageIdx = idx;
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.abs(i - idx);
      nodes[i].classList.toggle("on", i === idx);
      nodes[i].classList.toggle("past", i < idx);
      nodes[i].style.setProperty("--blur", `${Math.min(d * 0.5, 2)}px`);
      nodes[i].style.setProperty("--op", `${Math.max(1 - d * 0.11, 0.3)}`);
    }
    const cur = nodes[Math.max(idx, 0)];
    if (cur && Date.now() > stageScrollUntil) box.scrollTo({ top: cur.offsetTop - box.clientHeight * 0.42, behavior: "smooth" });
  }
  const line = lines[idx], node = nodes[idx];
  if (line?.rest && node) {
    const g = clamp((t - line.rest[0]) / (line.rest[1] - line.rest[0]), 0, 1);
    node.querySelectorAll(".dots i").forEach((dot, k) => dot.style.setProperty("--g", Math.min(Math.max(g * 3 - k, 0), 1)));
  }
}

async function stagePhoto(it) {
  const art = it ? itemArt(it, 1200) : "";
  $("stageArt").style.backgroundImage = art ? `url("${art}")` : "";
  if (!it?.artist) return;
  const url = await glass.artistPhoto(it.artist).catch(() => "");
  if (stageOpen && nowItem()?.artist === it.artist && url) $("stageArt").style.backgroundImage = `url("${url}")`;
}

function refreshStage() {
  if (!stageOpen) return;
  const it = nowItem();
  $("stageTitle").textContent = it?.title || "";
  $("stageArtist").textContent = it?.artist || "";
  renderStage();
  stagePhoto(it);
  loadLyrics(true);
}

function openStage() {
  const it = nowItem();
  if (!it) { status("Play something to see its lyrics."); return; }
  stageOpen = true;
  $("stage").hidden = false;
  $("stageTitle").textContent = it.title || "";
  $("stageArtist").textContent = it.artist || "";
  stagePhoto(it);
  renderStage();
  loadLyrics();
  cancelAnimationFrame(stageRaf);
  stageRaf = requestAnimationFrame(stageTick);
}
function closeStage() {
  stageOpen = false;
  $("stage").hidden = true;
  cancelAnimationFrame(stageRaf);
}
$("stageClose").onclick = closeStage;
$("miniStage").onclick = () => (stageOpen ? closeStage() : openStage());
$("stageLyrics").addEventListener("wheel", () => { stageScrollUntil = Date.now() + 3500; }, { passive: true });
$("stageLyrics").addEventListener("click", e => {
  const node = e.target.closest(".ly");
  const line = node && lyr?.synced && lyr.lines[+node.dataset.i];
  if (!line || line.rest || line.start == null) return;
  stageScrollUntil = 0;
  seekTo(Math.max(0, line.start - prefs.nudge + 0.01));
});

// ---- panes -------------------------------------------------------------------------------------
function setPane(name) {
  pane = name;
  $$("[data-pane]").forEach(b => {
    const on = b.dataset.pane === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("paneQueue").hidden = name !== "queue";
  $("paneLyrics").hidden = name !== "lyrics";
  $("paneEq").hidden = name !== "eq";
  cancelAnimationFrame(raf);
  if (name === "lyrics") { loadLyrics(); lyrIdx = -2; raf = requestAnimationFrame(tick); }
  if (name === "queue") renderQueue();
  if (name === "eq") applyEQ();
  modes();
}
$$("[data-pane]").forEach(b => b.onclick = () => setPane(b.dataset.pane));

function openPlayer(name) {
  $("player").hidden = false;
  setPane(name || pane);
  renderQueue();
  applyEQ();
}
function closePlayer() {
  $("player").hidden = true;
  cancelAnimationFrame(raf);
  modes();
}
$("miniExpand").onclick = () => openPlayer();
$("miniArtWrap").onclick = () => openPlayer();
$("playerCollapse").onclick = closePlayer;
$("miniQueue").onclick = () => openPlayer("queue");
$("miniLyrics").onclick = () => openPlayer("lyrics");
$("miniFav").onclick = () => toggleFavourite(nowItem());
$("playerFav").onclick = () => toggleFavourite(nowItem());

// ---- the library's own buttons and context menus -----------------------------------------------
async function toggleFavourite(item) {
  if (!item) return;
  if (item.local) {
    if (localFavs.has(item.id)) localFavs.delete(item.id); else localFavs.add(item.id);
    saveFavs();
    paintHearts();
    status(localFavs.has(item.id) ? "Added to Favorites" : "Removed from Favorites");
    return;
  }
  const id = String(item.id), on = appleFavs.has(id);
  try {
    if (on) { appleFavs.delete(id); await amp("DELETE", `/v1/me/ratings/songs/${item.playId || item.id}`); }
    else {
      appleFavs.add(id);
      await amp("PUT", `/v1/me/ratings/songs/${item.playId || item.id}`, { type: "rating", attributes: { value: 1 } });
    }
    paintHearts();
    status(on ? "Removed from Favorites" : "Added to Favorites");
  } catch (e) { status("Couldn't change the favourite: " + (e?.message || e), true); }
}

function activate(item, i) {
  if (!item) return;
  if (item.kind === "song") playAt(i);
  else if (item.kind === "station") playStation(item);
  else open(item);
}

$("content").addEventListener("click", e => {
  const card = e.target.closest("[data-idx]");
  if (!card) return;
  const item = items[+card.dataset.idx];
  if (!item) return;
  if (item.kind === "album" && (e.metaKey || e.ctrlKey) && !e.target.closest(".play-fab, .heart-btn, .more")) {
    e.preventDefault();
    toggleAlbumSelection(item);
    return;
  }
  if (e.target.closest(".heart-btn")) { toggleFavourite(item); return; }
  if (e.target.closest(".more")) { e.stopPropagation(); openMenu(item, e.clientX, e.clientY); return; }
  if (e.target.closest(".play-fab")) { run(ACTIONS.play(item)); return; }
  activate(item, +card.dataset.idx);
});
$("content").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target;
  if (!card.matches?.("[data-idx]")) return;   // inner buttons handle their own keys
  e.preventDefault();
  card.click();
});
$("content").addEventListener("contextmenu", e => {
  const card = e.target.closest("[data-idx]");
  const item = card && items[+card.dataset.idx];
  if (!item) return;
  const entries = menuEntries(item);
  if (!entries.filter(x => x && x !== "-").length) return;
  e.preventDefault();
  openMenu(item, e.clientX, e.clientY);
});

// ---- right-click menu --------------------------------------------------------------------------
const MENU_ICONS = {
  play: "i-play", shuffle: "i-shuffle", next: "i-next", later: "i-queue", library: "i-download",
  playlist: "i-plus", open: "i-chevron-right", reveal: "i-folder", removeLocal: "i-trash",
  back: "i-back", qplay: "i-play", qtop: "i-chevron-down", qup: "i-chevron-down",
  qdown: "i-chevron-down", qbottom: "i-chevron-down", qremove: "i-close",
  fetchLyrics: "i-lyrics", deletePlaylist: "i-trash", removeFromPlaylist: "i-close",
  goAlbum: "i-disc", goArtist: "i-users", mkLocal: "i-folder", mkApple: "i-music", review: "i-spark",
};

function menuEntries(item) {
  if (item.local) {
    if (item.kind === "playlist") return [
      ["play", "Play"], ["shuffle", "Shuffle"], "-",
      ["review", "Review Playlist…"], "-",
      ["deletePlaylist", "Delete playlist"],
    ];
    if (item.kind === "song") {
      const inPlaylist = currentPlaylist && (currentPlaylist.trackIds || []).includes(item.id);
      return [
        ["play", "Play"], ["next", "Play Next"], ["later", "Add to Queue"], "-",
        ["goAlbum", "Go to Album"], ["goArtist", "Go to Artist"], "-",
        ["playlist", "Add to Playlist…"],
        ...(inPlaylist ? [["removeFromPlaylist", "Remove from this playlist"], "-"] : []),
        ["fetchLyrics", "Fetch lyrics"], "-",
        ["reveal", "Show in Files"], ["removeLocal", "Remove from Library"],
      ];
    }
    if (item.kind === "album" || item.kind === "artist") return [
      ["play", "Play"], ["shuffle", "Shuffle"], ["next", "Play Next"], ["later", "Add to Queue"], "-",
      ["playlist", "Add to Playlist…"], "-",
      ["reveal", "Show in Files"],
    ];
    return [];
  }
  const signedIn = music?.isAuthorized;
  const canAdd = signedIn && !item.lib && ["song", "album", "playlist"].includes(item.kind);
  switch (item.kind) {
    case "song": return [["play", "Play"], ["next", "Play Next"], ["later", "Add to Queue"], "-",
                         ["goAlbum", "Go to Album"], ["goArtist", "Go to Artist"], "-",
                         canAdd && ["library", "Add to Library"], signedIn && ["playlist", "Add to Playlist…"]];
    case "album":
    case "playlist": {
      const entries = [["play", "Play"], ["shuffle", "Shuffle"], ["next", "Play Next"], ["later", "Add to Queue"], "-"];
      if (item.kind === "playlist" && item.canEdit) entries.push(["review", "Review Playlist…"], "-");
      entries.push(canAdd && ["library", "Add to Library"], signedIn && ["playlist", "Add to Playlist…"]);
      return entries;
    }
    case "artist": return [["open", "Go to Artist"], "-", ["play", "Play Top Songs"], ["shuffle", "Shuffle Top Songs"]];
    case "category": return item.id === "songs" ? [["shuffle", "Shuffle All"], ["play", "Play All"]] : [];
    default: return [];
  }
}

let menuItem = null;

function openMenu(item, x, y) {
  menuItem = item;
  fillMenu(menuEntries(item));
  placeMenu(x, y);
}

function fillMenu(entries) {
  const m = $("menu");
  m.innerHTML = "";
  entries.filter(Boolean).forEach(e => {
    if (e === "-") {
      if (m.lastChild && m.lastChild.tagName !== "HR") m.appendChild(document.createElement("hr"));
      return;
    }
    const b = el("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.dataset.act = e[0];
    if (e[2]) b.dataset.pl = e[2];
    if (MENU_ICONS[e[0]]) b.innerHTML = icon(MENU_ICONS[e[0]]);
    b.appendChild(document.createTextNode(e[1]));
    m.appendChild(b);
  });
  if (m.lastChild?.tagName === "HR") m.lastChild.remove();
}

function placeMenu(x, y) {
  const m = $("menu");
  m.hidden = false;
  const left = Math.min(x, innerWidth - m.offsetWidth - 8);
  const top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8));
  m.style.left = left + "px";
  m.style.top = top + "px";
  // grow out of the pointer, from whichever corner the menu was pushed to
  m.style.transformOrigin = `${left < x ? "right" : "left"} ${top < y ? "bottom" : "top"}`;
  m.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

$("menu").addEventListener("keydown", e => {
  const items = $$("button:not(:disabled)", $("menu"));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  } else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
  else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
});

document.addEventListener("click", () => { $("menu").hidden = true; });
document.addEventListener("contextmenu", e => {
  if (!e.defaultPrevented && !e.target.closest("#menu")) $("menu").hidden = true;
});

let editable = null;   // your playlists that can take songs, fetched once

$("menu").addEventListener("click", async e => {
  const b = e.target.closest("button");
  if (!b || !menuItem) return;
  const item = menuItem, act = b.dataset.act;
  if (act === "playlist") {                        // swap the menu for a list of playlists
    e.stopPropagation();
    const m = $("menu"), at = m.getBoundingClientRect();
    const entries = [["back", "‹ Back"], "-"];
    if (item.local) {
      entries.push(...(localPlaylists.length ? localPlaylists.map(p => ["ltopl", p.name, p.id]) : [["none", "No local playlists yet"]]));
      entries.push("-", ["lnew", "New playlist…"]);
    } else if (music?.isAuthorized) {
      entries.push(["apple", "Apple Music…"]);
    } else {
      entries.push(["none", "Sign in to use Apple playlists"]);
    }
    fillMenu(entries);
    placeMenu(at.left, at.top);
    return;
  }
  if (act === "apple") {                           // the editable Apple playlists
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

  if (act === "ltopl") {
    const pl = localPlaylists.find(p => p.id === b.dataset.pl);
    if (!pl) return;
    try {
      const n = await addToLocalPlaylist(pl, item);
      status(n ? `Added ${item.title} to ${pl.name}.` : `${item.title} is already in ${pl.name}.`);
    } catch (err) { status("Couldn't add to the playlist: " + (err?.message || err), true); }
    return;
  }
  if (act === "lnew") {
    const name = prompt("Name for the new playlist");
    if (name == null) return;
    const pl = newLocalPlaylist(name);
    try {
      await addToLocalPlaylist(pl, item);
      status(`Added ${item.title} to ${pl.name}.`);
      if (view === "library" && libraryFilter === "playlists") load();
    } catch (err) { status("Couldn't add to the playlist: " + (err?.message || err), true); }
    return;
  }
  if (act === "removeFromPlaylist") {
    const pl = currentPlaylist;
    if (!pl) return;
    pl.trackIds = (pl.trackIds || []).filter(id => id !== item.id);
    saveLocalPlaylists();
    status(`Removed from ${pl.name}.`);
    try { renderPage(await playlistPage(localPlaylistItem(pl))); } catch {}
    return;
  }
  if (act === "deletePlaylist") {
    const id = item.playlist?.id || item.id;
    localPlaylists = localPlaylists.filter(p => p.id !== id);
    saveLocalPlaylists();
    currentPlaylist = null;
    status(`Deleted ${item.title}.`);
    if (stack.length) back(); else if (view === "library") load();
    return;
  }
  if (act === "fetchLyrics") {
    try {
      const r = await glass.localFetchLyrics(item.path);
      if (r?.found) {
        status(r.synced ? `Synced lyrics saved for ${item.title}.` : `Plain lyrics saved for ${item.title}.`);
        if (nowItem()?.path === item.path) { loadLyrics(true); if (stageOpen) refreshStage(); }
      } else status(`No lyrics found for ${item.title}.`, true);
    } catch (err) { status("Couldn't fetch lyrics: " + (err?.message || err), true); }
    return;
  }
  if (act === "reveal") {
    const path = item.path || item.tracks?.[0]?.path;
    if (path) glass.localReveal(path);
    return;
  }
  if (act === "removeLocal") {
    if (!item.path) return;
    try {
      applyLocal(await glass.localRemoveTrack(item.path));
      localQueue = localQueue.filter(t => t.path !== item.path);
      stack = [];
      if (view === "local") renderPage(localPage());
      status(`Removed ${item.title} from the library.`);
      renderQueue();
    } catch (err) { status("Couldn't remove the file: " + (err?.message || err), true); }
    return;
  }
  try {
    if (act === "open" || act === "library" || act === "topl") status("Working…");
    const msg = act === "topl" ? await addToPlaylist(item, editable.find(p => p.id === b.dataset.pl)) : await ACTIONS[act](item);
    if (msg) status(msg);
  } catch (err) { status("Couldn't do that: " + (err?.message || err), true); }
  renderQueue();
});

// ---- account -----------------------------------------------------------------------------------
async function connect() {
  const acc = await glass.signIn();
  if (!acc?.token) return false;
  music.musicUserToken = acc.token;
  refreshAccount();
  return music.isAuthorized;
}

function refreshAccount() {
  const on = !!music?.isAuthorized;
  $("accountDot").classList.toggle("on", on);
  $("accountName").textContent = on ? "Apple Music" : "Not connected";
  $("accountDetail").textContent = on ? "Signed in" : "Sign in to play";
  $("accName").textContent = on ? "Apple Music" : "Not connected";
  $("accDetail").textContent = on
    ? `Signed in${music.storefrontCountryCode ? ` (${music.storefrontCountryCode.toUpperCase()})` : ""}. Streaming High Quality, 256 kbps AAC.`
    : "Sign in with your Apple ID to play full songs. Needs an Apple Music subscription.";
  $("accAction").textContent = on ? "Sign out" : "Connect";
  if (on) maybeAutoCreateSuggested();     // signing in is the other moment today's playlist can be made
}

$("accAction").onclick = async () => {
  if (!music) { status("Apple Music is still starting. Try again in a moment."); return; }
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

// ---- settings sheet ----------------------------------------------------------------------------
const overlay = $("overlay");
const toggleSettings = open => {
  overlay.hidden = !open;
  if (open) {
    refreshAccount();
    paintLocalSettings();
    showLastfmAuth();       // also finishes a Last.fm connection approved after Connect gave up
    showSpotifyCreds();
  }
};
$("settingsBtn").onclick = () => toggleSettings(overlay.hidden);
$("accountBtn").onclick = () => toggleSettings(true);
$("closeSettings").onclick = $("dim").onclick = () => toggleSettings(false);

$("rememberVol").checked = prefs.rememberVolume;
$("rememberVol").onchange = e => { prefs.rememberVolume = e.target.checked; savePrefs(); };
$("wordSync").checked = prefs.wordSync;
$("wordSync").onchange = e => {
  prefs.wordSync = e.target.checked;
  savePrefs();
  if (!$("player").hidden && pane === "lyrics") loadLyrics(true);
};

function paintLocalSettings() {
  const n = local.tracks.length;
  $("localStats").textContent = n
    ? `${n} songs · ${local.albums.length} albums · ${local.artists.length} artists`
    : "No folders added yet.";
  const roots = $("localRoots");
  roots.innerHTML = "";
  if (!local.roots.length) {
    roots.appendChild(el("li", "empty", "Nothing added yet"));
    return;
  }
  for (const r of local.roots) {
    const li = el("li");
    li.innerHTML = icon(r.kind === "folder" ? "i-folder" : "i-music");
    li.appendChild(el("span", "root-path", r.path));
    const x = iconBtn("i-close", "", "Stop reading this folder");
    x.onclick = async () => {
      try { applyLocal(await glass.localRemoveRoot(r.path)); }
      catch (e) { status("Couldn't remove the folder: " + (e?.message || e), true); }
    };
    li.appendChild(x);
    roots.appendChild(li);
  }
}

$("localAddFolder").onclick = () => localAction("addFolder");
$("localAddFiles").onclick = () => localAction("addFiles");
$("localRescan").onclick = () => localAction("rescan");

let clearLocalArmed = 0, clearLocalAt = 0, clearLocalTimer = 0;
$("localClear").onclick = () => {
  const b = $("localClear");
  if (clearLocalArmed > Date.now()) {
    if (Date.now() - clearLocalAt < 600) return;   // the second half of a double-click must not confirm
    clearLocalArmed = 0;
    clearTimeout(clearLocalTimer);
    b.textContent = "Clear library";
    localAction("clear");
    return;
  }
  clearLocalAt = Date.now();
  clearLocalArmed = clearLocalAt + 5000;
  b.textContent = "Click again to clear";
  clearLocalTimer = setTimeout(() => { clearLocalArmed = 0; b.textContent = "Clear library"; }, 5000);
};

glass.onLocalProgress(p => {
  const track = $("localProgressTrack"), bar = $("localProgressBar"), text = $("localProgressText");
  if (!p || !p.total) { track.hidden = true; text.textContent = ""; return; }
  track.hidden = false;
  bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
  text.textContent = `Reading ${p.done} of ${p.total}…`;
  if (p.done >= p.total) setTimeout(() => { track.hidden = true; text.textContent = ""; bar.style.width = "0%"; }, 800);
});

glass.onLyricsProgress(p => {
  const track = $("localProgressTrack"), bar = $("localProgressBar"), text = $("localProgressText");
  if (!p || p.finished) {
    if (p?.finished && p.total) status(p.found ? `Lyrics ready for ${p.found} of ${p.total}.` : "No new lyrics found.");
    track.hidden = true;
    text.textContent = "";
    return;
  }
  track.hidden = false;
  bar.style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`;
  text.textContent = `Fetching lyrics ${p.done} of ${p.total}…`;
});

$("localLyricsAll").onclick = async () => {
  try {
    const r = await glass.localFetchLyricsAll();
    status(r?.total ? `Asking LRCLIB for ${r.total} track${r.total === 1 ? "" : "s"}…` : "No local tracks to fetch.");
  } catch (e) { status("Couldn't start the lyric fetch: " + (e?.message || e), true); }
};

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
$("lfmKeySave").onclick = async () => {
  const r = await glass.setLastfmKey($("lfmKey").value);
  if (r?.error) { lfmNote("That key didn't work: " + r.error); return; }
  $("lfmKey").value = "";
  lfmNote(r?.has ? "Last.fm key saved." : "Last.fm key removed.");
  showLastfmAuth();
};
$("lfmUser").value = prefs.lastfmUser || "";

// Connecting Last.fm (key + secret + the session it gives back) is what lets Suggested read Last.fm's own
// recommendations instead of approximating them from genre charts. Nothing is sent anywhere else.
function paintLastfmAuth(st) {
  const connected = !!st?.user;
  $("lfmConnect").hidden = connected;
  $("lfmDisconnect").hidden = !connected;
  $("lfmConnect").disabled = !st?.hasSecret;
  $("lfmSignOut").hidden = !st?.page;
  $("lfmPageStatus").textContent = st?.page
    ? "Signed in: Suggested reads your Last.fm page directly."
    : "Not signed in: Suggested reads Last.fm through the API below instead.";
  $("lfmAuthStatus").textContent = connected
    ? `Connected as ${st.user}. Suggested uses Last.fm's own recommendations.`
    : st?.pending
      ? "Waiting for last.fm to confirm. Allow Orchard in the browser, then reopen Settings."
      : st?.hasSecret
        ? "Not connected. Press Connect and allow Orchard on last.fm to use its own suggestions."
        : "Not connected: Suggested uses your top genres. Add the API secret to use Last.fm's own suggestions.";
}

$("lfmSignIn").onclick = async () => {
  const b = $("lfmSignIn");
  b.disabled = true;
  $("lfmPageStatus").textContent = "Sign in to Last.fm in the window, then close it.";
  try {
    const r = await glass.lastfmLogin();
    suggestedCache = null;
    if (r?.signedIn) {
      // The playlist made a moment ago came from the fallback; let today's build again from the page.
      prefs.suggestedAttempt = null;
      prefs.suggestedPlaylist = null;
      savePrefs();
      maybeAutoCreateSuggested();
    }
    paintLastfmAuth(r?.page);
    if (!r?.signedIn) $("lfmPageStatus").textContent = "Signed in, but the Suggested page didn't load. Try again.";
    if (view === "suggested") load();
  } catch (e) {
    $("lfmPageStatus").textContent = String(e?.message || e).replace(/^.*Error: /, "");
  }
  b.disabled = false;
};

$("lfmSignOut").onclick = async () => {
  paintLastfmAuth(await glass.lastfmSignOut());
  suggestedCache = null;
  if (view === "suggested") load();
};
async function showLastfmAuth() {
  try { paintLastfmAuth(await glass.lastfmAuth()); } catch {}
}
$("lfmSecretSave").onclick = async () => {
  const st = await glass.setLastfmSecret($("lfmSecret").value);
  $("lfmSecret").value = "";
  paintLastfmAuth(st);
  $("lfmAuthStatus").textContent = st.hasSecret ? "Secret saved. Press Connect to allow Orchard." : "Secret removed.";
};
$("lfmConnect").onclick = async () => {
  const b = $("lfmConnect");
  b.disabled = true;
  $("lfmAuthStatus").textContent = "Waiting for you to allow Orchard on last.fm in your browser…";
  try {
    const st = await glass.lastfmConnect();
    paintLastfmAuth(st);
    suggestedCache = null;
    // Remember who connected: the genre fallback and the page's subtitle both read the username.
    if (st?.user) { prefs.lastfmUser = st.user; $("lfmUser").value = st.user; savePrefs(); }
    // The playlist made a moment ago came from the fallback; let today's build again with the real thing.
    prefs.suggestedAttempt = null;
    prefs.suggestedPlaylist = null;
    savePrefs();
    maybeAutoCreateSuggested();
    if (view === "suggested") load();
  } catch (e) {
    // Keep the reason on screen: repainting the status here would replace it with "Not connected".
    const msg = String(e?.message || e).replace(/^.*Error: /, "");
    $("lfmAuthStatus").textContent = /signature/i.test(msg)
      ? msg + " — check that the API secret is the one for this API key."
      : msg;
  }
  b.disabled = false;
};
$("lfmDisconnect").onclick = async () => {
  paintLastfmAuth(await glass.lastfmDisconnect());
  suggestedCache = null;
};
showLastfmAuth();

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

let clearFavs = null, clearFavsAt = 0, clearFavsTimer = 0;
$("lfmClear").onclick = async () => {
  const b = $("lfmClear");
  if (!music?.isAuthorized) { lfmNote("Sign in to Apple Music first (Account, above)."); return; }
  if (clearFavs) {                                   // second click: do it
    if (Date.now() - clearFavsAt < 600) return;       // the second half of a double-click must not confirm
    const todo = clearFavs; clearFavs = null; clearTimeout(clearFavsTimer);
    b.disabled = true;
    try {
      for (const [n, f] of todo.entries()) {
        await amp("DELETE", `/v1/me/ratings/${f.path}/${f.id}`);
        if (n % 10 === 9) lfmNote(`Removed ${n + 1} of ${todo.length}…`);
      }
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
      clearFavsAt = Date.now();
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

// ---- window, sidebar and the keyboard ----------------------------------------------------------
$$("[data-win]").forEach(b => b.onclick = () => glass.window(b.dataset.win));

if (prefs.sidebarCollapsed) document.body.classList.add("sidebar-collapsed");
$("sidebarToggle").onclick = () => {
  const on = document.body.classList.toggle("sidebar-collapsed");
  prefs.sidebarCollapsed = on;
  savePrefs();
};

document.addEventListener("keydown", e => {
  if (review) {                                    // the reviewer owns the keys while it is open
    if (e.key === "Escape") { e.preventDefault(); closeReviewer(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); decideReview(false); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); decideReview(true); return; }
    if (e.code === "Space") { e.preventDefault(); togglePlay(); return; }
  }
  const el = document.activeElement;
  // Any text box counts (the search, the API keys), so typing there never fires a shortcut.
  const typing = !!el && (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["range", "checkbox"].includes(el.type)));
  const slider = el?.type === "range";   // sliders take the arrow keys themselves
  if (e.key === "Escape") {
    if (!$("menu").hidden) { $("menu").hidden = true; return; }
    if (typing) { el.blur(); return; }
    if (!overlay.hidden) { toggleSettings(false); return; }
    if (stageOpen) { closeStage(); return; }
    if (!$("player").hidden) { closePlayer(); return; }
    back();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault(); toggleSettings(false); $("q").focus(); $("q").select(); return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case "/": e.preventDefault(); toggleSettings(false); $("q").focus(); $("q").select(); break;
    case "l": case "y":
      if (stageOpen) closeStage();
      if (!$("player").hidden && pane === "lyrics") closePlayer(); else openPlayer("lyrics");
      break;
    case "f": if (stageOpen) closeStage(); else openStage(); break;
    case "q":
      if (!$("player").hidden && pane === "queue") closePlayer(); else openPlayer("queue");
      break;
    case "e": if ($("player").hidden) openPlayer(); else closePlayer(); break;
    case "m": toggleMute(); break;
    case "Backspace": back(); break;
    case " ": e.preventDefault(); $("play").click(); break;
    case "ArrowLeft": case "ArrowRight": {
      if (slider || !nowItem()) return;
      e.preventDefault();
      if (e.shiftKey) { key === "ArrowRight" ? nextTrack() : prevTrack(); return; }
      seekTo(currentTime() + (key === "ArrowRight" ? 5 : -5));
      break;
    }
    case "ArrowUp": case "ArrowDown":
      if (slider || el?.closest?.("#content, #queue, #lyrics, #sheet, #menu")) return;   // let lists scroll
      e.preventDefault();
      setVolume(volume + (key === "ArrowUp" ? 0.05 : -0.05));
      break;
  }
});

if ("mediaSession" in navigator) {
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
  set("play", () => { if (localItem()) localAudio.play().catch(() => {}); else music?.play(); });
  set("pause", () => { if (localItem()) localAudio.pause(); else music?.pause(); });
  set("nexttrack", nextTrack);
  set("previoustrack", prevTrack);
  set("seekto", d => seekTo(d.seekTime || 0));
  set("seekbackward", d => seekTo(currentTime() - (d.seekOffset || 10)));
  set("seekforward", d => seekTo(currentTime() + (d.seekOffset || 10)));
}

// ---- what's playing, for the desktop (MPRIS on Linux: media keys, the panel, scrobblers) --------
function report(extra = {}) {
  const it = nowItem();
  const cover = it ? itemArt(it, 600) : "";
  glass.mprisState({
    status: it ? (isPlaying() ? "Playing" : "Paused") : "Stopped",
    position: currentTime(),
    volume,
    track: it ? {
      id: it.id,
      title: it.title || "",
      artist: it.artist || "",
      album: it.album || "",
      albumArtist: it.albumArtist || it.artist || "",
      length: currentDuration(),
      trackNumber: it.trackNumber || 0,
      art: cover ? new URL(cover, location.href).href : "",
      url: it.url || "",
    } : null,
    ...extra,
  });
}

setInterval(() => { if (localItem() && !localAudio.paused) report(); }, 5000);

glass.onMpris(async ({ action, value }) => {
  switch (action) {
    case "play": if (localItem()) await localAudio.play().catch(() => {}); else await music?.play(); break;
    case "pause": if (localItem()) localAudio.pause(); else await music?.pause(); break;
    case "playpause":
      if (localItem()) { if (localAudio.paused) await localAudio.play().catch(() => {}); else localAudio.pause(); }
      else if (music) { music.isPlaying ? await music.pause() : await music.play(); }
      break;
    case "next": nextTrack(); break;
    case "previous": prevTrack(); break;
    case "seek": seekTo(Math.max(0, value)); return;
    case "seekby": seekTo(Math.max(0, currentTime() + value)); return;
    case "volume": setVolume(value); break;
  }
  report();
});

// ---- first paint -------------------------------------------------------------------------------
$$(".art-fallback").forEach(node => { if (!node.firstChild) node.innerHTML = icon("i-music"); });
showTimes(0, 0);
setItem();
setPlayingUI();
setView("home");
load();
paintLocalSettings();
loadLocal().then(state => { if (state?.tracks?.length) glass.localFetchLyricsMissing(); });
