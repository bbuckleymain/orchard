// Your most-played Last.fm tracks, matched to Apple Music songs. Reads only: nothing is changed on either service here.
const { matches } = require("./musixmatch");

const TIMEOUT = 15000;
const GAP = 3200;   // iTunes allows about 20 searches a minute
const sleep = ms => new Promise(done => setTimeout(done, ms));

// Every track played `min` times or more, most played first. Last.fm lists them in that order, so reading stops
// at the first page that drops below `min`.
async function topTracks({ user, key, min, fetchFn = fetch }) {
  const out = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const query = new URLSearchParams({ method: "user.gettoptracks", user, api_key: key, format: "json", limit: "200", page: String(page) });
    const j = await (await fetchFn("https://ws.audioscrobbler.com/2.0/?" + query, { signal: AbortSignal.timeout(TIMEOUT) })).json();
    if (j.error) throw new Error("Last.fm: " + j.message);
    pages = +j.toptracks?.["@attr"]?.totalPages || 1;
    for (const t of j.toptracks?.track || []) {
      if (+t.playcount < min) return out;
      out.push({ artist: t.artist.name, title: t.name, plays: +t.playcount });
    }
  }
  return out;
}

// Apple Music's own /search refuses this app's requests (429 "Request is forbidden"), so songs are looked up with the
// public iTunes Search API, whose trackId is the Apple Music song id. Slow by design: one search every 3.2 s. `cache`
// (artist|title -> candidates) is filled as it goes, so a run that is stopped or limited carries on where it left off.
const keyOf = (country, t) => `${country}|${t.artist}|${t.title}`.toLowerCase();

async function lookUp(tracks, { country, cache, save = () => {}, onProgress = () => {}, fetchFn = fetch, pause = sleep }) {
  const out = [];
  try {
    for (const [i, t] of tracks.entries()) {
      const key = "v2|" + keyOf(country, t);   // v2: results now carry the clean/explicit flag and 8 per search
      if (!cache[key]) {
        const url = "https://itunes.apple.com/search?" + new URLSearchParams({ term: `${t.title} ${t.artist}`, entity: "song", limit: "8", country });
        let r = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { r = await fetchFn(url, { signal: AbortSignal.timeout(30000) }); }
          catch { r = null; await pause(5000 * (attempt + 1)); continue; }   // a timeout or dropped connection: try again
          if (r.status !== 403 && r.status !== 429) break;
          await pause(60000);   // limited: wait a minute
        }
        if (!r?.ok) throw new Error(`iTunes search ${r ? "answered " + r.status : "didn't answer"}; run Preview again in a few minutes, your progress is saved`);
        cache[key] = ((await r.json()).results || []).map(s => ({ id: String(s.trackId), name: s.trackName, artistName: s.artistName, album: s.collectionName, explicit: s.trackExplicitness }));
        await pause(GAP);
        if (i % 20 === 19) save();
      }
      out.push(cache[key]);
      onProgress(i + 1, tracks.length);
    }
  } finally { save(); }   // however it stops, what was found so far is kept
  return out;
}

// Do two names differ in their words? Catches a "Live", "Remix" or "Remastered" tag, or another artist.
const words = text => new Set(String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const differs = (a, b) => { const x = words(a), y = words(b); return x.size !== y.size || [...x].some(w => !y.has(w)); };

// Live and clean versions are never picked. A word in the song's own title doesn't count against it ("Live Forever",
// "Clean"): a version is rejected only when it has more "live" / "clean" words than the Last.fm title does, or when the
// Last.fm title carries no such tag and the album is a live one / the song is flagged clean. Asking for "(Live)" allows live.
const count = (text, w) => (String(text || "").match(new RegExp(`\\b${w}\\b`, "gi")) || []).length;
const LIVE_ALBUM = /\blive (at|from|in|on)\b|\(live\)|\blive$|unplugged|in concert/i;
const LIVE_TAG = /\(live|\[live|\blive (at|from|in|on)\b|- live\b|\blive$/i;
const CLEAN_TAG = /\(clean|\[clean|- clean\b|\bclean (version|edit)\b/i;
function badVersion(c, t) {
  if (count(c.name, "live") > count(t.title, "live") || (LIVE_ALBUM.test(c.album || "") && !LIVE_TAG.test(t.title))) return "live";
  if (count(c.name, "clean") > count(t.title, "clean") || (c.explicit === "cleaned" && !CLEAN_TAG.test(t.title))) return "clean";
  return null;
}

// Each matched song carries `from` (the Last.fm entries that led to it, to compare by eye) and `keys` (for the favourited log).
function pick(tracks, candidates, country) {
  const found = new Map(), unmatched = [];
  tracks.forEach((t, i) => {
    const fits = c => matches(c.name, c.artistName, 0, t.title, t.artist, 0);
    const song = (candidates[i] || []).find(c => !badVersion(c, t) && fits(c));
    if (!song) unmatched.push((candidates[i] || []).some(c => badVersion(c, t) && fits(c)) ? { ...t, onlyLiveOrClean: true } : t);
    else if (found.has(song.id)) { const m = found.get(song.id); m.keys.push(keyOf(country, t)); m.from.push(t); }
    else found.set(song.id, { id: song.id, artist: song.artistName, title: song.name, album: song.album, keys: [keyOf(country, t)], from: [t],
                              odd: differs(song.name, t.title) || differs(song.artistName, t.artist) });
  });
  return { matched: [...found.values()], unmatched };
}

// The matches as CSV for checking by eye: differing ones first, then songs not found, then the rest.
function toCsv(matched, unmatched) {
  const rows = [];
  for (const m of matched) for (const f of m.from)
    rows.push([m.odd ? "CHECK" : "ok", f.artist, f.title, f.plays, m.artist, m.title, m.album || "", m.id]);
  for (const t of unmatched) rows.push([t.onlyLiveOrClean ? "ONLY LIVE/CLEAN" : "NOT FOUND", t.artist, t.title, t.plays, "", "", "", ""]);
  const rank = { CHECK: 0, "NOT FOUND": 1, "ONLY LIVE/CLEAN": 1, ok: 2 };
  rows.sort((a, b) => rank[a[0]] - rank[b[0]]);
  const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [["status", "lastfm_artist", "lastfm_title", "plays", "apple_artist", "apple_title", "apple_album", "apple_id"], ...rows].map(r => r.map(cell).join(",")).join("\n") + "\n";
}

module.exports = { topTracks, lookUp, pick, keyOf, toCsv };
