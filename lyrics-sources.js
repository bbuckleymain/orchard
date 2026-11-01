// Lyrics from outside Apple, for songs Apple has none for. Ported from Aerwave (aerwave/netease.py, aerwave/lrclib.py).
// Both come back as LRC text; NetEase's is the "enhanced" kind with a stamp before every word.

const TIMEOUT = 9000;

async function ask(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const wordsOf = text => new Set((String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 1));
const stamp = ms => {
  const cs = Math.floor(Math.max(0, ms) / 10), s = Math.floor(cs / 100);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

// ---- NetEase: the one free source of word-by-word timings ----
const NETEASE = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Orchard/1.0", Referer: "https://music.163.com" };
const CREDIT = /^[一-鿿][一-鿿\s]{0,8}\s*[:：]/;   // the 作词/编曲 credits NetEase opens with
const ISWORD = /^[\p{L}\p{N}]/u;

function neteaseToLrc(yrc) {
  const out = [];
  for (let raw of String(yrc || "").split("\n")) {
    raw = raw.trim();
    if (!raw || raw.startsWith("{")) continue;
    const head = raw.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;
    const pieces = [...raw.slice(head[0].length).matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)];
    if (!pieces.length) continue;
    const spoken = pieces.map(p => p[3]).join("").trim();
    if (!out.length && CREDIT.test(spoken)) continue;
    const line = [`[${stamp(+head[1])}]`];
    for (const [, start, , textRaw] of pieces) {
      const text = textRaw.trim();
      if (!text) continue;
      if (line.length > 1 && !ISWORD.test(text)) line[line.length - 1] += text;   // punctuation joins its word
      else line.push(`<${stamp(+start)}> ${text}`);
    }
    if (line.length > 1) {
      const last = pieces[pieces.length - 1];
      line.push(`<${stamp(+last[1] + +last[2])}>`);   // where the singing stops, so breaks show
      out.push(line.join(" "));
    }
  }
  return out.join("\n");
}

function fits(song, title, artist, duration) {
  const wanted = wordsOf(title), found = wordsOf(song.name);
  if (!wanted.size || ![...wanted].some(w => found.has(w))) return false;
  if ([...wanted].filter(w => !found.has(w)).length > wanted.size / 2) return false;
  const singers = wordsOf((song.artists || []).map(a => a.name).join(" "));
  const want = wordsOf(artist);
  if (want.size && ![...want].some(w => singers.has(w))) return false;
  const theirs = (song.duration || 0) / 1000;
  return !(duration && theirs && Math.abs(theirs - duration) > 8);
}

async function netease(artist, title, duration) {
  const term = `${title} ${artist}`.replace(/\s+/g, " ").trim();
  const found = await ask(`https://music.163.com/api/search/get?type=1&limit=6&s=${encodeURIComponent(term)}`, NETEASE);
  const song = (found?.result?.songs || []).find(s => fits(s, title, artist, duration));
  if (!song) return "";
  const lyric = await ask(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=1&yv=1`, NETEASE);
  return neteaseToLrc(lyric?.yrc?.lyric);
}

// ---- LRCLIB: the open database, timed by the line ----
const LRCLIB = { "User-Agent": "Orchard/1.0 (desktop music player)" };
const worded = lrc => /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/.test(lrc || "");

async function lrclib(artist, title, album, duration) {
  const params = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album) params.set("album_name", album);
  if (duration) params.set("duration", String(Math.round(duration)));
  let records = [];
  const exact = await ask(`https://lrclib.net/api/get?${params}`, LRCLIB);
  if (exact && typeof exact === "object" && !Array.isArray(exact)) records = [exact];
  if (!records.length) records = (await ask(`https://lrclib.net/api/search?${params}`, LRCLIB)) || [];
  if (!records.length) records = (await ask(`https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`)}`, LRCLIB)) || [];
  const usable = records.filter(r => r && (r.syncedLyrics || r.plainLyrics));
  if (!usable.length) return null;
  const gap = r => duration ? Math.abs((+r.duration || 0) - duration) : 0;
  usable.sort((a, b) => (worded(b.syncedLyrics) - worded(a.syncedLyrics)) || (!!b.syncedLyrics - !!a.syncedLyrics) || (gap(a) - gap(b)));
  return { synced: usable[0].syncedLyrics || "", plain: usable[0].plainLyrics || "" };
}

// Best first: word-timed NetEase, then LRCLIB (synced, then plain).
async function external({ artist, title, album, duration, wordSync }) {
  if (!artist || !title) return null;
  if (wordSync) {
    const lrc = await netease(artist, title, duration);
    if (lrc) return { text: lrc, source: "NetEase" };
  }
  const found = await lrclib(artist, title, album, duration);
  if (found?.synced) return { text: found.synced, source: "LRCLIB" };
  if (!wordSync) {
    const lrc = await netease(artist, title, duration);
    if (lrc) return { text: lrc, source: "NetEase" };
  }
  if (found?.plain) return { text: found.plain, source: "LRCLIB" };
  return null;
}

module.exports = { external };
