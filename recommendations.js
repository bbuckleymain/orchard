// Last.fm recommendations -> Apple Music.
// Fetches Last.fm's recommended albums and artists pages and matches each to the Apple Music catalog.
// The pages are public but personalized when signed in to Last.fm; without a session they may be empty.
// Also provides fallback: derive recommendations from user's top tracks (via Last.fm API).
const TIMEOUT = 15000;
const sleep = ms => new Promise(done => setTimeout(done, ms));

// Last.fm wraps the content in server-rendered markup, but the exact classes rotate over time. We pull
// the album/artist anchors out of the HTML and read the title off the link text, which is stable.
function anchors(html) {
  const out = [];
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1] || "", text = m[2] || "";
    const title = text.replace(/<[^>]*>/g, "").trim();
    if (!title) continue;
    if (href.includes("/music/")) out.push({ title, href });
  }
  return out;
}

// Albums look like /music/<Artist>/<Album>; artists like /music/<Artist>.
function parseRecommendedAlbums(html) {
  const out = [];
  for (const a of anchors(html)) {
    if (!a.href.includes("/music/")) continue;
    const parts = a.href.split("/music/").pop().split("/").map(s => decodeURIComponent(s));
    const artist = parts.length > 1 ? parts[0] : "";
    const album = parts.length > 1 ? parts[1] : a.title;
    if (!album || album === artist) continue;
    out.push({ title: album, artist });
  }
  const seen = new Set();
  const list = [];
  for (const a of out) {
    const k = `${a.title}|${a.artist}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(a);
  }
  return list.slice(0, 20);
}

function parseRecommendedArtists(html) {
  const out = [];
  for (const a of anchors(html)) {
    if (!a.href.includes("/music/")) continue;
    const parts = a.href.split("/music/").pop().split("/").map(s => decodeURIComponent(s));
    const artist = parts[0];
    if (!artist) continue;
    if (out.some(o => o.name.toLowerCase() === artist.toLowerCase())) continue;
    out.push({ name: artist });
  }
  return out.slice(0, 20);
}

// ---- fetch pages --------------------------------------------------------------
async function fetchRecommendedAlbums({ fetchFn = fetch, url = "https://www.last.fm/music/+recommended/albums" } = {}) {
  try {
    const html = await fetchFn(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(TIMEOUT),
    }).then(r => r.text());
    const list = parseRecommendedAlbums(html);
    return list.length ? list : [];
  } catch (e) {
    console.warn("[Orchard] Last.fm recommended albums fetch error:", e.message);
    return [];
  }
}

async function fetchRecommendedArtists({ fetchFn = fetch, url = "https://www.last.fm/music/+recommended/artists" } = {}) {
  try {
    const html = await fetchFn(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(TIMEOUT),
    }).then(r => r.text());
    const list = parseRecommendedArtists(html);
    return list.length ? list : [];
  } catch (e) {
    console.warn("[Orchard] Last.fm recommended artists fetch error:", e.message);
    return [];
  }
}

// ---- Apple Music matching ------------------------------------------------------
async function searchApple(type, term, { token, storefront, fetchFn = fetch }) {
  const headers = {
    Authorization: "Bearer " + token,
    "media-user-token": "",
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
  };
  const url = `https://amp-api.music.apple.com/v1/catalog/${storefront}/search?` + new URLSearchParams({ term, types: type, limit: "5" });
  let r = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status === 429) { await sleep(1500); r = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT) }); }
  if (!r.ok) throw new Error(`Apple Music answered ${r.status}`);
  return (await r.json()).results?.[type]?.data || [];
}

async function matchAlbums(albums, { token, storefront, fetchFn = fetch } = {}) {
  const out = [];
  for (const a of albums) {
    try {
      const results = await searchApple("albums", `${a.title} ${a.artist}`, { token, storefront, fetchFn });
      const match = results.find(r => {
        const attrs = r.attributes;
        return attrs.name.toLowerCase() === a.title.toLowerCase() &&
               attrs.artistName.toLowerCase() === a.artist.toLowerCase();
      }) || results[0];
      if (match) {
        out.push({ ...a, found: true, apple: match.attributes });
      } else {
        out.push({ ...a, found: false });
      }
    } catch (e) {
      out.push({ ...a, found: false, error: e.message });
    }
  }
  return out;
}

async function matchArtists(artists, { token, storefront, fetchFn = fetch } = {}) {
  const out = [];
  for (const a of artists) {
    try {
      const results = await searchApple("artists", a.name, { token, storefront, fetchFn });
      const match = results.find(r => r.attributes.name.toLowerCase() === a.name.toLowerCase()) || results[0];
      if (match) {
        out.push({ ...a, found: true, apple: match.attributes });
      } else {
        out.push({ ...a, found: false });
      }
    } catch (e) {
      out.push({ ...a, found: false, error: e.message });
    }
  }
  return out;
}

// ---- fetch tracks from matched albums/artists ----------------------------------
async function albumTracks(albumId, { token, storefront, fetchFn = fetch } = {}) {
  const headers = { Authorization: "Bearer " + token, Origin: "https://music.apple.com", Referer: "https://music.apple.com/" };
  const url = `https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}?limit=50`;
  const r = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data || []).map(t => t.attributes);
}

async function artistTopTracks(artistId, { token, storefront, fetchFn = fetch } = {}) {
  const headers = { Authorization: "Bearer " + token, Origin: "https://music.apple.com", Referer: "https://music.apple.com/" };
  const url = `https://amp-api.music.apple.com/v1/catalog/${storefront}/artists/${artistId}/top-songs?limit=20`;
  const r = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data || []).map(t => t.attributes);
}

// ---- build track list for the daily playlist ----------------------------------
async function buildSuggestedTracks({ albums, artists, token, storefront, fetchFn = fetch, maxTracks = 30 } = {}) {
  const tracks = [];
  for (const a of albums) {
    if (!a.found || !a.apple?.id) continue;
    try {
      const tr = await albumTracks(a.apple.id, { token, storefront, fetchFn });
      for (const t of tr) {
        tracks.push({ ...t, local: false, id: t.id, playId: t.playParams?.id || "" });
        if (tracks.length >= maxTracks) break;
      }
    } catch {}
    if (tracks.length >= maxTracks) break;
  }
  for (const a of artists) {
    if (!a.found || !a.apple?.id) continue;
    try {
      const tr = await artistTopTracks(a.apple.id, { token, storefront, fetchFn });
      for (const t of tr) {
        if (!tracks.find(existing => existing.playId === t.playParams?.id)) {
          tracks.push({ ...t, local: false, id: t.id, playId: t.playParams?.id || "" });
          if (tracks.length >= maxTracks) break;
        }
      }
    } catch {}
    if (tracks.length >= maxTracks) break;
  }
  return tracks.slice(0, maxTracks);
}

module.exports = {
  parseRecommendedAlbums, parseRecommendedArtists,
  fetchRecommendedAlbums, fetchRecommendedArtists,
  matchAlbums, matchArtists,
  albumTracks, artistTopTracks,
  buildSuggestedTracks,
};