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

// The Web API, when the user has supplied their own client id and secret. A client-credentials token can read
// any public playlist in full, so the 50-track limit of the embed page doesn't apply.
async function apiToken({ clientId, clientSecret, fetchFn = fetch }) {
  const r = await fetchFn("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) {
    throw new Error(r.status === 400 || r.status === 401
      ? "Spotify rejected the client id or secret."
      : `Spotify's token endpoint answered ${r.status}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error("Spotify didn't return an access token.");
  return j.access_token;
}

async function apiPlaylist(id, { clientId, clientSecret, fetchFn = fetch } = {}) {
  const token = await apiToken({ clientId, clientSecret, fetchFn });
  const get = async url => {
    const r = await fetchFn(url, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status === 404) throw new Error("That playlist is private, empty, or doesn't exist.");
    if (!r.ok) throw new Error(`Spotify answered ${r.status}`);
    return r.json();
  };
  const base = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}`;
  const meta = await get(`${base}?fields=name`);
  const tracks = [];
  let url = `${base}/tracks?limit=100&fields=${encodeURIComponent("items(track(name,artists(name),duration_ms,type)),next")}`;
  while (url) {
    const page = await get(url);
    for (const it of page.items || []) {
      const t = it?.track;
      if (!t || t.type === "episode" || !t.name) continue;     // podcasts in a playlist aren't songs
      tracks.push({ title: t.name, artist: (t.artists || []).map(a => a.name).join(", "), ms: +t.duration_ms || 0 });
    }
    url = page.next || "";
    if (tracks.length > 5000) break;                            // a runaway page chain isn't a playlist
  }
  if (!tracks.length) throw new Error("That playlist is private, empty, or doesn't exist.");
  return { name: String(meta.name || "Spotify playlist").trim(), tracks, partial: false };
}

module.exports = { playlistId, embed, apiPlaylist };
