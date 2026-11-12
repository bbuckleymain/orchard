const test = require("node:test");
const assert = require("node:assert/strict");
const { topTracks, matchAll } = require("../lastfm.js");

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

test("matchAll skips wrong songs and counts the same Apple song once", async () => {
  const song = (id, name, artistName) => ({ id, attributes: { name, artistName } });
  const fetchFn = async url => {
    const term = new URL(url).searchParams.get("term");
    const data = term.startsWith("Gone") ? [] : term.startsWith("Hi") ? [song("1", "Other Song", "Zed"), song("2", "Hi There", "Ann")] : [];
    return reply({ results: { songs: { data } } })();
  };
  const tracks = [{ artist: "Ann", title: "Hi There", plays: 20 }, { artist: "Ann", title: "Hi There (live)", plays: 12 }, { artist: "Bo", title: "Gone", plays: 11 }];
  const r = await matchAll(tracks, { token: "t", storefront: "us", fetchFn });
  assert.deepEqual(r.matched.map(s => s.id), ["2"]);
  assert.deepEqual(r.unmatched.map(t => t.title), ["Gone"]);
});
