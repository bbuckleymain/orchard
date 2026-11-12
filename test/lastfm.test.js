const test = require("node:test");
const assert = require("node:assert/strict");
const { topTracks, lookUp, pick, toCsv } = require("../lastfm.js");

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
  const r = pick(tracks, candidates, "gb");
  assert.deepEqual(r.matched.map(m => [m.id, m.keys, m.from.map(f => f.title)]),
                   [["2", ["gb|ann|hi there", "gb|ann|hi there (live)"], ["Hi There", "Hi There (live)"]]]);
  assert.deepEqual(r.unmatched.map(t => t.title), ["Gone"]);
});

test("lookUp searches iTunes once per song, reuses the cache and waits out a 429", async () => {
  const hit = (id, name, artist) => ({ ok: true, status: 200, json: async () => ({ results: [{ trackId: id, trackName: name, artistName: artist, collectionName: "Alb" }] }) });
  const urls = [], waits = [];
  let calls = 0;
  const fetchFn = async url => { urls.push(url); return ++calls === 1 ? { ok: false, status: 429 } : hit(7, "Hi", "Ann"); };
  const cache = {};
  const tracks = [{ artist: "Ann", title: "Hi" }];
  const first = await lookUp(tracks, { country: "gb", cache, fetchFn, pause: ms => waits.push(ms) });
  assert.deepEqual(first, [[{ id: "7", name: "Hi", artistName: "Ann", album: "Alb" }]]);
  assert.deepEqual(waits, [60000, 3200], "a minute after the 429, then the normal gap");
  await lookUp(tracks, { country: "gb", cache, fetchFn, pause: ms => waits.push(ms) });
  assert.equal(urls.length, 2, "second run came from the cache");
});

test("toCsv lists differing matches first and quotes commas", () => {
  const same = { id: "1", artist: "Ann", title: "Hi", album: "A, B", from: [{ artist: "Ann", title: "Hi", plays: 20 }], odd: false };
  const live = { id: "2", artist: "Ann", title: "Yo (Live)", album: "", from: [{ artist: "Ann", title: "Yo", plays: 15 }], odd: true };
  const lines = toCsv([same, live], [{ artist: "Bo", title: "Gone", plays: 11 }]).trim().split("\n");
  assert.deepEqual(lines.slice(1), ["CHECK,Ann,Yo,15,Ann,Yo (Live),,2", "NOT FOUND,Bo,Gone,11,,,,", 'ok,Ann,Hi,20,Ann,Hi,"A, B",1']);
});

test("pick marks a different version as odd", () => {
  const r = pick([{ artist: "Ann", title: "Yo", plays: 15 }], [[{ id: "2", name: "Yo (Live)", artistName: "Ann" }]], "gb");
  assert.equal(r.matched[0].odd, true);
});
