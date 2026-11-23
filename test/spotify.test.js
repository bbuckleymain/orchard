const test = require("node:test");
const assert = require("node:assert/strict");
const spotify = require("../spotify.js");

const page = entity => `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { state: { data: { entity } } } },
})}</script></body></html>`;
const reply = body => async () => ({ ok: true, status: 200, text: async () => body });
const track = (title, subtitle, duration) => ({ title, subtitle, duration, uri: "spotify:track:x" });

test("playlistId accepts a link, a URI, or the bare id", () => {
  assert.equal(spotify.playlistId("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"), "37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(spotify.playlistId("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"), "37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(spotify.playlistId("  37i9dQZF1DXcBWIGoYBM5M "), "37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(spotify.playlistId("https://open.spotify.com/track/abc"), "");
  assert.equal(spotify.playlistId(""), "");
});

test("embed reads the name and tracks from the page Spotify serves", async () => {
  const html = page({
    name: "Road Trip", title: "Road Trip",
    trackList: [track("Saosin", "Saosin"), track("The Question", "Emery", 180000)],
  });
  const out = await spotify.embed("id", { fetchFn: reply(html) });
  assert.equal(out.name, "Road Trip");
  assert.deepEqual(out.tracks, [
    { title: "Saosin", artist: "Saosin", ms: 0 },
    { title: "The Question", artist: "Emery", ms: 180000 },
  ]);
  assert.equal(out.partial, false);
});

test("embed flags a list cut off at the embed page's limit", async () => {
  const list = Array.from({ length: 50 }, (_, i) => track(`Song ${i}`, "Artist"));
  const out = await spotify.embed("id", { fetchFn: reply(page({ name: "Big", trackList: list })) });
  assert.equal(out.tracks.length, 50);
  assert.equal(out.partial, true);
});

test("a private or empty playlist is an error, not an empty import", async () => {
  await assert.rejects(spotify.embed("id", { fetchFn: reply(page({ name: "Secret", trackList: [] })) }), /private, empty/);
  await assert.rejects(spotify.embed("id", { fetchFn: reply("<html>no data</html>") }), /playlist page/);
});

test("a Spotify error status is reported", async () => {
  const fetchFn = async () => ({ ok: false, status: 404, text: async () => "" });
  await assert.rejects(spotify.embed("id", { fetchFn }), /404/);
});

test("apiPlaylist exchanges the client credentials and pages through every track", async () => {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", auth: opts.headers?.Authorization || "" });
    if (url.startsWith("https://accounts.spotify.com/api/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "AT" }) };
    }
    if (url.includes("?fields=name")) return { ok: true, status: 200, json: async () => ({ name: "Long List" }) };
    if (url.includes("offset=2")) return { ok: true, status: 200, json: async () => ({
      items: [{ track: { name: "Two", artists: [{ name: "B" }, { name: "C" }], duration_ms: 2000, type: "track" } }],
      next: null,
    }) };
    return { ok: true, status: 200, json: async () => ({
      items: [
        { track: { name: "One", artists: [{ name: "A" }], duration_ms: 1000, type: "track" } },
        { track: { name: "Podcast", artists: [], duration_ms: 0, type: "episode" } },
      ],
      next: "https://api.spotify.com/v1/playlists/x/tracks?offset=2",
    }) };
  };
  const out = await spotify.apiPlaylist("x", { clientId: "ID", clientSecret: "SECRET", fetchFn });
  assert.equal(out.name, "Long List");
  assert.deepEqual(out.tracks, [
    { title: "One", artist: "A", ms: 1000 },
    { title: "Two", artist: "B, C", ms: 2000 },
  ], "episodes are skipped and several artists are joined");
  assert.equal(out.partial, false);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].auth, /^Basic /);
  assert.ok(calls.slice(1).every(c => c.auth === "Bearer AT"));
});

test("apiPlaylist reports rejected credentials and private playlists", async () => {
  const badCreds = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(spotify.apiPlaylist("x", { clientId: "I", clientSecret: "S", fetchFn: badCreds }), /rejected the client id or secret/);

  const fetchFn = async url => url.startsWith("https://accounts.spotify.com")
    ? { ok: true, status: 200, json: async () => ({ access_token: "AT" }) }
    : { ok: false, status: 404, json: async () => ({}) };
  await assert.rejects(spotify.apiPlaylist("x", { clientId: "I", clientSecret: "S", fetchFn }), /private, empty/);
});
