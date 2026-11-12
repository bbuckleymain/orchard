// Your most-played Last.fm tracks, found on Apple Music. Reads only: nothing is changed on either service here.
const { matches } = require("./musixmatch");

const TIMEOUT = 15000;
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

// Finds each track in the Apple Music catalog. Returns { matched: [{ id, artist, title }], unmatched: [track] }.
// Two Last.fm entries that land on the same Apple song count once.
async function matchAll(tracks, { token, storefront, fetchFn = fetch }) {
  const headers = { Authorization: "Bearer " + token, Origin: "https://music.apple.com", Referer: "https://music.apple.com/" };
  async function find(t) {
    const url = `https://amp-api.music.apple.com/v1/catalog/${storefront}/search?` + new URLSearchParams({ term: `${t.title} ${t.artist}`, types: "songs", limit: "5" });
    let r = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status === 429) { await sleep(1500); r = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT) }); }
    if (!r.ok) throw new Error(`Apple Music answered ${r.status}`);
    const songs = (await r.json()).results?.songs?.data || [];
    return songs.find(s => matches(s.attributes.name, s.attributes.artistName, 0, t.title, t.artist, 0));
  }

  const found = new Map(), unmatched = [];
  let next = 0;
  const worker = async () => {
    while (next < tracks.length) {
      const t = tracks[next++], song = await find(t);
      if (song) found.set(song.id, { id: song.id, artist: song.attributes.artistName, title: song.attributes.name });
      else unmatched.push(t);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return { matched: [...found.values()], unmatched };
}

module.exports = { topTracks, matchAll };
