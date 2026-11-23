// Last.fm -> Apple Music, for the Suggested tab. Reads only: Last.fm's API says what you listen to and what
// sounds like it, then Apple's catalogue is searched for each result. Nothing is written to either service.
const crypto = require("crypto");

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

// The tags you listen to most. This is the closest the public API gets to Last.fm's own Suggested page:
// its recommender is private (it needs a signed session), but your genre tags are public and describe the
// same taste, so the charts for those tags land on the same kind of artist.
const JUNK_TAG = /^(seen live|favorites?|favourites?|awesome|love|love it|owned|albums i own|good|best|music|spotify|lastfm|my music|all time|greatest|under 2000 listeners)$/i;

async function topTags({ user, key, limit = 6, fetchFn } = {}) {
  const j = await call("user.gettoptags", { user, limit: String(limit + 6) }, { key, fetchFn });
  return (j.toptags?.tag || [])
    .map(t => ({ name: String(t.name || "").trim(), count: +t.count || 0 }))
    .filter(t => t.name && !JUNK_TAG.test(t.name))
    .slice(0, limit);
}

// Artists at the top of those tags, best tag first. A tag's own chart position is part of the score, so a
// big genre's number one beats a small genre's number ten. Artists you already play are left out.
async function artistsByTags({ tags = [], key, exclude = [], perTag = 25, limit = 12, fetchFn } = {}) {
  const skip = new Set(exclude.map(norm));
  const best = new Map();
  for (const [i, tag] of tags.entries()) {
    const weight = 1 / (i + 1);
    let j;
    try { j = await call("tag.gettopartists", { tag: tag.name, limit: String(perTag) }, { key, fetchFn }); }
    catch { continue; }
    const list = j.topartists?.artist || [];
    list.forEach((a, n) => {
      const name = String(a.name || "").trim(), k = norm(name);
      if (!k || skip.has(k)) return;
      const score = weight * (1 - n / (list.length + 1));
      if (!best.has(k) || score > best.get(k).score) best.set(k, { name, score, tag: tag.name });
    });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- signed calls, for the methods that need the user to have allowed Orchard on Last.fm -------------
// Last.fm signs a request with md5 of its parameters (sorted, name then value) followed by the API secret.
// `format` and `api_sig` themselves are not part of that string.
const md5 = s => crypto.createHash("md5").update(s, "utf8").digest("hex");

function sign(params, secret) {
  const base = Object.keys(params).sort().map(k => k + params[k]).join("");
  return md5(base + secret);
}

async function signedCall(method, params, { key, secret, sk, fetchFn = fetch }) {
  const signed = { api_key: key, method, ...params, ...(sk ? { sk } : {}) };
  const query = new URLSearchParams({ ...signed, api_sig: sign(signed, secret), format: "json" });
  const r = await fetchFn("https://ws.audioscrobbler.com/2.0/?" + query, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`Last.fm answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error("Last.fm: " + j.message);
  return j;
}

// Step one of the desktop auth flow: a token to send the user to last.fm with.
async function authGetToken({ key, secret, fetchFn } = {}) {
  const j = await signedCall("auth.getToken", {}, { key, secret, fetchFn });
  return { token: String(j.token || "") };
}

// Step two, once they have allowed Orchard: the session key, which does not expire.
async function authGetSession({ key, secret, token, fetchFn } = {}) {
  const j = await signedCall("auth.getSession", { token }, { key, secret, fetchFn });
  return { name: String(j.session?.name || ""), key: String(j.session?.key || "") };
}

// The recommendations Last.fm itself shows on its Suggested page. This is the private method the public
// tag charts only approximate, and it needs the session key.
async function recommendedArtists({ key, secret, sk, user, limit = 12, fetchFn } = {}) {
  const j = await signedCall("user.getRecommendedArtists", { ...(user ? { user } : {}), limit: String(limit) },
    { key, secret, sk, fetchFn });
  return (j.recommendations?.artist || [])
    .map(a => ({ name: String(a.name || "").trim() }))
    .filter(a => a.name)
    .slice(0, limit);
}

// What to suggest: Last.fm's own recommendations when the user has connected their account, then the genre
// charts, then artists near the charts with no username at all.
async function recommendArtists({ user, key, secret, sk, limit = 12, fetchFn } = {}) {
  if (secret && sk) {
    try {
      const own = await recommendedArtists({ key, secret, sk, user, limit, fetchFn });
      if (own.length) return own;
    } catch { /* not connected any more, or the token was revoked: fall back below */ }
  }
  const seeds = await topArtists({ user, key, limit: user ? 50 : 8, fetchFn });
  if (!user) return similarArtists({ seeds, key, limit, fetchFn });
  const tags = await topTags({ user, key, fetchFn });
  if (!tags.length) return similarArtists({ seeds, key, limit, fetchFn });
  return artistsByTags({ tags, key, exclude: seeds.slice(0, 10).map(s => s.name), limit, fetchFn });
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
  topArtists, topTags, artistsByTags, similarArtists, albumsByArtists, recommendArtists,
  sign, authGetToken, authGetSession, recommendedArtists,
  matchAlbums, matchArtists, albumTracks, artistTopTracks, buildSuggestedTracks,
};
