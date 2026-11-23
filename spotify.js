// Spotify -> Apple Music, for importing a playlist. A public playlist can be read without any credentials:
// open.spotify.com/embed/playlist/<id> is what Spotify's own widget loads, and its __NEXT_DATA__ carries the
// playlist name and tracks. That page stops at the first 50 tracks, which the caller is told about.
const TIMEOUT = 15000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// Accepts an open.spotify.com link (with or without a ?si= tail), a spotify:playlist: URI, or the bare id.
function playlistId(input) {
  const s = String(input || "").trim();
  const m = /playlist[/:]([A-Za-z0-9]{16,})/.exec(s) || /^([A-Za-z0-9]{16,})$/.exec(s);
  return m ? m[1] : "";
}

function embedTrack(t) {
  return {
    title: String(t?.title || "").trim(),
    artist: String(t?.subtitle || "").trim(),
    ms: +t?.duration || 0,
  };
}

// The playlist page Spotify serves to its embed player. No token, no cookies: it is the same page an
// anonymous visitor gets, so private playlists are simply unavailable here.
async function embed(id, { fetchFn = fetch } = {}) {
  const r = await fetchFn(`https://open.spotify.com/embed/playlist/${encodeURIComponent(id)}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`Spotify answered ${r.status}`);
  const html = await r.text();
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("Spotify didn't send a playlist page.");
  let data;
  try { data = JSON.parse(m[1]); } catch { throw new Error("Spotify's playlist page wasn't readable."); }
  const ent = data?.props?.pageProps?.state?.data?.entity;
  const list = ent?.trackList;
  if (!Array.isArray(list) || !list.length) throw new Error("That playlist is private, empty, or doesn't exist.");
  const tracks = list.map(embedTrack).filter(t => t.title);
  return {
    name: String(ent.name || ent.title || "Spotify playlist").trim(),
    tracks,
    partial: tracks.length >= 50,     // the embed page stops there
  };
}

module.exports = { playlistId, embed };
