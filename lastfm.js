// Your most-played Last.fm tracks, matched to Apple Music songs. Reads only: nothing is changed on either service here.
const { matches } = require("./musixmatch");

const TIMEOUT = 15000;

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

// Picks the Apple song for each Last.fm track from the search results the window fetched (Apple only answers
// searches from the browser window, not from here). candidates[i] is the list of { id, name, artistName } for tracks[i].
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

module.exports = { topTracks, pick };
