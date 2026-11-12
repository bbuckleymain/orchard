// Your most-played Last.fm tracks, matched to Apple Music songs. Reads only: nothing is changed on either service here.
const { matches } = require("./musixmatch");

const TIMEOUT = 15000;
const GAP = 3200;        // iTunes allows about 20 searches a minute
const APPLE_GAP = 400;   // Apple Music's own search is asked more gently than it needs
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
      out.push({ artist: t.artist.name, title: t.name, plays: +t.playcount, mbid: t.mbid || "" });
    }
  }
  return out;
}

// Apple Music's own /search refuses this app's requests (429 "Request is forbidden"), so songs are looked up with the
// public iTunes Search API, whose trackId is the Apple Music song id. Slow by design: one search every 3.2 s. `cache`
// (artist|title -> candidates) is filled as it goes, so a run that is stopped or limited carries on where it left off.
const keyOf = (country, t) => `${country}|${t.artist}|${t.title}`.toLowerCase();

async function lookUp(tracks, { country, cache, save = () => {}, onProgress = () => {}, fetchFn = fetch, pause = sleep, appleSearch = async () => null, appleIsrc = async () => null, appleArtistSongs = async () => null, stats = {} }) {
  const out = [];
  stats.apple = stats.apple || 0; stats.itunes = stats.itunes || 0;

  async function itunes(params) {
    const url = "https://itunes.apple.com/search?" + new URLSearchParams({ entity: "song", country, ...params });
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { r = await fetchFn(url, { signal: AbortSignal.timeout(30000) }); }
      catch { r = null; await pause(5000 * (attempt + 1)); continue; }   // a timeout or dropped connection: try again
      if (r.status !== 403 && r.status !== 429) break;
      await pause(60000);   // limited: wait a minute
    }
    if (!r?.ok) throw new Error(`iTunes search ${r ? "answered " + r.status : "didn't answer"}; run Preview again in a few minutes, your progress is saved`);
    const list = ((await r.json()).results || []).map(s => ({ id: String(s.trackId), name: s.trackName, artistName: s.artistName, album: s.collectionName, explicit: s.trackExplicitness }));
    stats.itunes++;
    await pause(GAP);
    return list;
  }

  // Apple Music's own search comes first. It answers null when it refuses (429), and then iTunes search is used for the
  // next 25 songs before Apple is tried again.
  let appleDownUntil = 0;
  async function ask(i, step) {
    if (i >= appleDownUntil) {
      const list = await appleSearch(step.term, step.apple);
      if (list) { stats.apple++; await pause(APPLE_GAP); return list; }
      appleDownUntil = i + 25;
    }
    return itunes(step.itunes);
  }

  // MusicBrainz: the ISRCs (recording codes) of a recording, by the MusicBrainz id Last.fm gives. One request a second.
  async function isrcsOf(mbid) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchFn(`https://musicbrainz.org/ws/2/recording/${mbid}?inc=isrcs&fmt=json`, { headers: { "User-Agent": "Orchard/1.0 (https://github.com/bbuckleymain/orchard)" }, signal: AbortSignal.timeout(20000) });
        await pause(1100);
        if (r.status === 503) { await pause(2000); continue; }
        return r.ok ? ((await r.json()).isrcs || []) : [];
      } catch { return []; }
    }
    return [];
  }

  // Every song on Apple Music by an artist, from the artist's own albums. iTunes search finds the artist's id (and leaves
  // out songs that aren't sold one by one, which is why it misses real songs); Apple Music's album pages have them all.
  async function artistCatalogue(name) {
    const k = `artist|${country}|${name.toLowerCase()}`;
    if (cache[k]) return cache[k];
    let ids = [];
    try {
      const r = await fetchFn("https://itunes.apple.com/search?" + new URLSearchParams({ term: name, entity: "musicArtist", limit: "5", country }), { signal: AbortSignal.timeout(30000) });
      await pause(GAP);
      if (r.ok) ids = ((await r.json()).results || []).filter(a => !differs(a.artistName, name)).slice(0, 3).map(a => String(a.artistId));
    } catch { return []; }
    const songs = [];
    for (const id of ids) {
      const found = await appleArtistSongs(id);
      if (found) songs.push(...found.filter(s => !songs.some(o => o.id === s.id)));
      await pause(APPLE_GAP);
    }
    if (songs.length) cache[k] = songs;   // not remembered when empty, so a failed lookup is tried again
    return songs;
  }

  try {
    for (const [i, t] of tracks.entries()) {
      const key = "v5|" + keyOf(country, t);   // v5: only exact results are remembered; the artist's albums are searched
      for (const v of ["v4|", "v3|"]) { const old = cache[v + keyOf(country, t)]; if (!cache[key] && old?.some(c => isExact(c, t))) cache[key] = old; }   // older results that were exact stay good
      if (!cache[key]) {
        const both = `${t.title} ${t.artist}`, clean = `${tidy(t.title)} ${primaryArtist(t.artist)}`;
        const steps = [
          { term: both, apple: 10, itunes: { term: both, limit: "8" } },
          { term: both, apple: 25, itunes: { term: both, limit: "50" } },
          { term: t.title, apple: 25, itunes: { term: t.title, attribute: "songTerm", limit: "100" } },
          { term: clean, apple: 25, itunes: { term: clean, limit: "50" } },                                          // no "(feat. …)", first artist only
          { term: tidy(t.title), apple: 25, itunes: { term: tidy(t.title), attribute: "songTerm", limit: "100" } },
        ].filter((step, n, all) => all.findIndex(o => o.term === step.term && o.apple === step.apple) === n);
        let list = [];
        for (const [n, step] of steps.entries()) {
          if (n && list.some(c => isExact(c, t))) break;
          const more = await ask(i, step);
          list = [...list, ...more.filter(m => !list.some(c => c.id === m.id))];
        }
        if (!list.some(c => isExact(c, t))) {   // not found by searching: look through the artist's albums
          const fit = (await artistCatalogue(primaryArtist(t.artist))).filter(c => matches(tidy(c.name), c.artistName, 0, tidy(t.title), t.artist, 0));
          if (fit.length) { stats.albums = (stats.albums || 0) + 1; list = [...fit, ...list.filter(m => !fit.some(c => c.id === m.id))]; }
        }
        if (t.mbid && !list.some(c => isExact(c, t))) {   // last resort: look the recording up by its ISRC
          for (const isrc of (await isrcsOf(t.mbid)).slice(0, 3)) {
            const found = await appleIsrc(isrc);
            if (found?.length) { stats.isrc = (stats.isrc || 0) + 1; list = [...found.map(c => ({ ...c, byIsrc: true })), ...list]; break; }
          }
        }
        if (list.some(c => isExact(c, t))) cache[key] = list;   // a miss is not remembered: it may be found next time
        else out.push(list), stats.missed = (stats.missed || 0) + 1;
        if (i % 20 === 19) save();
      }
      if (cache[key]) out.push(cache[key]);
      onProgress(i + 1, tracks.length);
    }
  } finally { save(); }   // however it stops, what was found so far is kept
  return out;
}

// Do two names differ in their words? Catches a "Live", "Remix" or "Remastered" tag, or another artist.
const words = text => new Set(String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
// "Remastered", "(2011 Remaster)" and "- Remastered 2009" are fine, so they are not counted.
const REMASTER = /\s*[(\[–-]\s*(?:\d{4}\s+)?(?:digital\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4}))*\s*[)\]]?/gi;
// "(feat. X)", "[ft. X]", "- feat. X" and a trailing "feat. X" are credits, not part of the song's name.
const FEAT = [/\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, /\s*[-–]\s*(?:feat\.?|ft\.?|featuring)\s.*$/i, /\s+(?:feat\.?|ft\.?|featuring)\s.*$/i];
const tidy = text => FEAT.reduce((t, re) => t.replace(re, ""), String(text || "").replace(REMASTER, "")).trim();
// The first artist of "A, B", "A & B", "A feat. B" or "A x B".
const primaryArtist = artist => String(artist || "").split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\band\b)\s*/i)[0].trim() || String(artist || "");
const differs = (a, b) => { const x = words(tidy(a)), y = words(tidy(b)); return x.size !== y.size || [...x].some(w => !y.has(w)); };
// A result that is the right song, not live or clean, and has no differences. One found by ISRC (the recording's own
// code) is the right recording whatever it is called.
const isExact = (c, t) => !!c.byIsrc || (matches(tidy(c.name), c.artistName, 0, tidy(t.title), t.artist, 0) && !badVersion(c, t) && !differs(c.name, t.title)
  && (!differs(c.artistName, t.artist) || !differs(c.artistName, primaryArtist(t.artist))));

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
    const fits = c => matches(tidy(c.name), c.artistName, 0, tidy(t.title), t.artist, 0);
    const song = (candidates[i] || []).find(c => isExact(c, t)) || (candidates[i] || []).find(c => !badVersion(c, t) && fits(c));
    if (!song) unmatched.push((candidates[i] || []).some(c => badVersion(c, t) && fits(c)) ? { ...t, onlyLiveOrClean: true } : t);
    else if (found.has(song.id)) { const m = found.get(song.id); m.keys.push(keyOf(country, t)); m.from.push(t); }
    else found.set(song.id, { id: song.id, artist: song.artistName, title: song.name, album: song.album, keys: [keyOf(country, t)], from: [t],
                              odd: !isExact(song, t) });
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
  return csv([["status", "lastfm_artist", "lastfm_title", "plays", "apple_artist", "apple_title", "apple_album", "apple_id"], ...rows]);
}

const csv = rows => {
  const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return rows.map(r => r.map(cell).join(",")).join("\n") + "\n";
};

// The set-aside songs (matches that differ from the Last.fm name) with a link each, for adding to favourites by hand.
function toManualCsv(entries, country) {
  const link = e => e.id ? `https://music.apple.com/${country}/song/${e.id}` : `https://music.apple.com/${country}/search?term=${encodeURIComponent(e.from.title + " " + e.from.artist)}`;
  const note = e => e.id ? "differs from the Last.fm name" : e.onlyLiveOrClean ? "only live or clean versions found: search for it" : "not found on Apple Music: search for it";
  return csv([["lastfm_artist", "lastfm_title", "apple_artist", "apple_title", "apple_album", "link", "note", "added_by_hand"],
              ...entries.map(e => [e.from.artist, e.from.title, e.artist, e.title, e.album, link(e), note(e), e.added ? "yes" : ""])]);
}

module.exports = { topTracks, lookUp, pick, keyOf, toCsv, toManualCsv };
