// Last.fm -> Apple Music, for the Suggested tab. Reads only: Last.fm's API says what you listen to and what
// sounds like it, then Apple's catalogue is searched for each result. Nothing is written to either service.
const TIMEOUT = 15000;

// "Björk" and "bjork" are the same artist, and "Song (Remastered 2011)" is the same song. Comparing on this
// form is what stops a recommendation being dropped for a diacritic or a bracketed edition.
const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\s*[([][^)\]]*(remaster|deluxe|edition|version|anniversary|mono|stereo)[^)\]]*[)\]]/g, "")
  .replace(/\s+-\s+.*$/, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

async function call(method, params, { key, fetchFn = fetch }) {
  const query = new URLSearchParams({ method, api_key: key, format: "json", ...params });
  const r = await fetchFn("https://ws.audioscrobbler.com/2.0/?" + query, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`Last.fm answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error("Last.fm: " + j.message);
  return j;
}

// What you actually listen to, most played first. Without a username the charts stand in, so the tab has
// something to show before a username is filled in.
async function topArtists({ user, key, period = "1month", limit = 8, fetchFn } = {}) {
  const j = user
    ? await call("user.gettopartists", { user, period, limit: String(limit) }, { key, fetchFn })
    : await call("chart.gettopartists", { limit: String(limit) }, { key, fetchFn });
  const list = (user ? j.topartists?.artist : j.artists?.artist) || [];
  return list.map(a => ({ name: String(a.name || "").trim(), plays: +a.playcount || 0 })).filter(a => a.name);
}

// Artists that sound like the ones you play, minus the ones you already play. Last.fm's match score decides
// the order, so the closest neighbours come first.
async function similarArtists({ seeds = [], key, perSeed = 5, limit = 12, fetchFn } = {}) {
  const known = new Set(seeds.map(s => norm(s.name)));
  const best = new Map();
  for (const seed of seeds) {
    let j;
    try { j = await call("artist.getsimilar", { artist: seed.name, limit: String(perSeed), autocorrect: "1" }, { key, fetchFn }); }
    catch { continue; }                      // one unknown seed must not sink the whole list
    for (const a of j.similarartists?.artist || []) {
      const name = String(a.name || "").trim(), k = norm(name);
      if (!k || known.has(k)) continue;
      const match = +a.match || 0;
      if (!best.has(k) || match > best.get(k).match) best.set(k, { name, match });
    }
  }
  return [...best.values()].sort((a, b) => b.match - a.match).slice(0, limit);
}

// A couple of records from each suggested artist. Compilations and live records are skipped: they match on
// Apple Music but are a poor first thing to hear from someone new.
const NOT_A_RECORD = /\b(greatest hits|best of|essential|anthology|compilation|live at|live in|collection)\b/i;

async function albumsByArtists({ artists = [], key, perArtist = 2, limit = 12, fetchFn } = {}) {
  const out = [], seen = new Set();
  for (const a of artists) {
    let j;
    try { j = await call("artist.gettopalbums", { artist: a.name, limit: String(perArtist + 4), autocorrect: "1" }, { key, fetchFn }); }
    catch { continue; }
    let taken = 0;
    for (const al of j.topalbums?.album || []) {
      const title = String(al.name || "").trim(), k = norm(title);
      if (!k || seen.has(k) || NOT_A_RECORD.test(title)) continue;
      seen.add(k);
      out.push({ title, artist: a.name });
      if (++taken >= perArtist || out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ---- Apple Music matching ------------------------------------------------------------------------
async function searchApple(type, term, { token, storefront, fetchFn = fetch }) {
  const headers = {
    Authorization: "Bearer " + token,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
  };
  const url = `https://amp-api.music.apple.com/v1/catalog/${encodeURIComponent(storefront)}/search?` +
    new URLSearchParams({ term, types: type, limit: "5" });
  const send = () => fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  let r = await send();
  if (r.status === 429) { await new Promise(done => setTimeout(done, 1500)); r = await send(); }
  if (!r.ok) throw new Error(`Apple Music answered ${r.status}`);
  return (await r.json()).results?.[type]?.data || [];
}

// Searches run a few at a time: serially, twelve lookups feel frozen; all at once, Apple starts answering 429.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) { const at = next++; out[at] = await fn(list[at], at); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

async function matchAlbums(albums, { token, storefront, fetchFn = fetch } = {}) {
  return mapLimit(albums, 4, async a => {
    try {
      const results = await searchApple("albums", `${a.title} ${a.artist}`, { token, storefront, fetchFn });
      const title = norm(a.title), artist = norm(a.artist);
      const exact = results.find(r => norm(r.attributes?.name) === title && norm(r.attributes?.artistName) === artist);
      const match = exact || results.find(r => norm(r.attributes?.name) === title) || results[0];
      return match ? { ...a, found: true, apple: match } : { ...a, found: false };
    } catch (e) { return { ...a, found: false, error: e.message }; }
  });
}

async function matchArtists(artists, { token, storefront, fetchFn = fetch } = {}) {
  return mapLimit(artists, 4, async a => {
    try {
      const results = await searchApple("artists", a.name, { token, storefront, fetchFn });
      const name = norm(a.name);
      const match = results.find(r => norm(r.attributes?.name) === name) || results[0];
      return match ? { ...a, found: true, apple: match } : { ...a, found: false };
    } catch (e) { return { ...a, found: false, error: e.message }; }
  });
}

// ---- songs to put in the playlist ---------------------------------------------------------------
// Apple resources, not bare attributes: the renderer turns these into its own items with toItem().
async function albumTracks(albumId, { token, storefront, fetchFn = fetch } = {}) {
  const headers = { Authorization: "Bearer " + token, Origin: "https://music.apple.com", Referer: "https://music.apple.com/" };
  const r = await fetchFn(`https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}?limit=50`,
    { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) return [];
  return (await r.json()).data || [];
}

async function artistTopTracks(artistId, { token, storefront, fetchFn = fetch } = {}) {
  const headers = { Authorization: "Bearer " + token, Origin: "https://music.apple.com", Referer: "https://music.apple.com/" };
  const r = await fetchFn(`https://amp-api.music.apple.com/v1/catalog/${storefront}/artists/${artistId}/top-songs?limit=20`,
    { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) return [];
  return (await r.json()).data || [];
}

// A few songs from each record first, so the playlist is a spread of suggestions rather than one album's
// worth; then each artist's top songs, and only then the rest of the albums to fill any gap.
async function buildSuggestedTracks({ albums = [], artists = [], token, storefront, fetchFn = fetch, maxTracks = 30 } = {}) {
  const out = [], seen = new Set(), fetched = new Map();
  const add = r => {
    const id = r?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    out.push(r);
    return true;
  };
  const take = (list, per) => {
    let taken = 0;
    for (const t of list) {
      if (out.length >= maxTracks || taken >= per) break;
      if (add(t)) taken++;
    }
  };
  // Each album is asked for once; a second pass reuses the answer instead of hitting Apple again.
  const tracksOfAlbum = a => {
    if (!fetched.has(a)) fetched.set(a, albumTracks(a.apple.id, { token, storefront, fetchFn }).catch(() => []));
    return fetched.get(a);
  };
  const usable = list => list.filter(a => a.found && a.apple?.id);

  for (const a of usable(albums)) {
    if (out.length >= maxTracks) break;
    take(await tracksOfAlbum(a), 3);
  }
  for (const a of usable(artists)) {
    if (out.length >= maxTracks) break;
    try { take(await artistTopTracks(a.apple.id, { token, storefront, fetchFn }), 2); } catch {}
  }
  for (const a of usable(albums)) {
    if (out.length >= maxTracks) break;
    take(await tracksOfAlbum(a), Infinity);
  }
  return out.slice(0, maxTracks);
}

module.exports = {
  norm,
  topArtists, similarArtists, albumsByArtists,
  matchAlbums, matchArtists, albumTracks, artistTopTracks, buildSuggestedTracks,
};
