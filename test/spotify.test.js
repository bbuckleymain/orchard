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
