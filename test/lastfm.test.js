const test = require("node:test");
const assert = require("node:assert/strict");
const { topTracks, pick } = require("../lastfm.js");

const reply = body => async () => ({ ok: true, status: 200, json: async () => body });
const track = (name, artist, plays) => ({ name, artist: { name: artist }, playcount: String(plays) });

test("topTracks stops at the first track below the minimum", async () => {
  const pages = [{ toptracks: { "@attr": { totalPages: "2" }, track: [track("A", "x", 30), track("B", "x", 10)] } },
                 { toptracks: { "@attr": { totalPages: "2" }, track: [track("C", "x", 9), track("D", "x", 50)] } }];
  let n = 0;
  const out = await topTracks({ user: "u", key: "k", min: 10, fetchFn: async () => reply(pages[n++])() });
  assert.deepEqual(out.map(t => t.title), ["A", "B"]);
  assert.equal(n, 2, "reads the second page, finds C is too low, stops");
});

test("topTracks turns a Last.fm error into an Error", async () => {
  await assert.rejects(topTracks({ user: "u", key: "k", min: 10, fetchFn: reply({ error: 6, message: "User not found" }) }), /User not found/);
});

test("pick skips wrong songs and counts the same Apple song once", () => {
  const c = (id, name, artistName) => ({ id, name, artistName });
  const tracks = [{ artist: "Ann", title: "Hi There", plays: 20 }, { artist: "Ann", title: "Hi There (live)", plays: 12 }, { artist: "Bo", title: "Gone", plays: 11 }];
  const candidates = [[c("1", "Other Song", "Zed"), c("2", "Hi There", "Ann")], [c("2", "Hi There", "Ann")], []];
  const r = pick(tracks, candidates);
  assert.deepEqual(r.matched, [{ id: "2", artist: "Ann", title: "Hi There" }]);
  assert.deepEqual(r.unmatched.map(t => t.title), ["Gone"]);
});
