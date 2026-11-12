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
async function lookUp(tracks, { country, cache, save = () => {}, onProgress = () => {}, fetchFn = fetch, pause = sleep }) {
  const out = [];
  for (const [i, t] of tracks.entries()) {
    const key = `${country}|${t.artist}|${t.title}`.toLowerCase();
    if (!cache[key]) {
      const url = "https://itunes.apple.com/search?" + new URLSearchParams({ term: `${t.title} ${t.artist}`, entity: "song", limit: "5", country });
      let r;
      for (let attempt = 0; attempt < 4; attempt++) {
        r = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT) });
        if (r.status !== 403 && r.status !== 429) break;
        await pause(60000);   // limited: wait a minute
      }
      if (!r.ok) { save(); throw new Error(`iTunes search answered ${r.status}; run Preview again in a few minutes, your progress is saved`); }
      cache[key] = ((await r.json()).results || []).map(s => ({ id: String(s.trackId), name: s.trackName, artistName: s.artistName }));
      await pause(GAP);
      if (i % 20 === 19) save();
    }
    out.push(cache[key]);
    onProgress(i + 1, tracks.length);
  }
  save();
  return out;
}

// Picks the Apple song for each Last.fm track from lookUp's results. candidates[i] is the list of { id, name, artistName } for tracks[i].
// Returns { matched: [{ id, artist, title }], unmatched: [track] }. Two Last.fm entries that land on the same Apple song count once.
function pick(tracks, candidates) {
  const found = new Map(), unmatched = [];
  tracks.forEach((t, i) => {
    const song = (candidates[i] || []).find(c => matches(c.name, c.artistName, 0, t.title, t.artist, 0));
    if (song) found.set(song.id, { id: song.id, artist: song.artistName, title: song.name });
    else unmatched.push(t);
  });
  return { matched: [...found.values()], unmatched };
}

module.exports = { topTracks, lookUp, pick };
