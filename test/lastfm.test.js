const test = require("node:test");
const assert = require("node:assert/strict");
const { topTracks, lookUp, pick, toCsv, toManualCsv } = require("../lastfm.js");

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
  assert.deepEqual(first, [[{ id: "7", name: "Hi", artistName: "Ann", album: "Alb", explicit: undefined }]]);
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
  const r = pick([{ artist: "Ann", title: "Yo", plays: 15 }], [[{ id: "2", name: "Yo (Acoustic)", artistName: "Ann" }]], "gb");
  assert.equal(r.matched[0].odd, true);
});

test("lookUp retries a timed-out search and saves progress when it gives up", async () => {
  const ok = { ok: true, status: 200, json: async () => ({ results: [{ trackId: 5, trackName: "Hi", artistName: "Ann", collectionName: "A" }] }) };
  let calls = 0, saved = 0;
  const flaky = async () => { if (++calls === 1) throw new Error("The operation was aborted due to timeout"); return ok; };
  const cache = {};
  await lookUp([{ artist: "Ann", title: "Hi" }], { country: "gb", cache, fetchFn: flaky, pause: () => {} });
  assert.equal(calls, 2);
  const dead = async () => { throw new Error("timeout"); };
  await assert.rejects(lookUp([{ artist: "Bo", title: "X" }], { country: "gb", cache, save: () => saved++, fetchFn: dead, pause: () => {} }), /didn't answer/);
  assert.equal(saved, 1, "saved even though it failed");
});

test("pick skips live and clean versions but not when the Last.fm name asks for them", () => {
  const c = (id, name, extra = {}) => ({ id, name, artistName: "Ann", ...extra });
  const pickOne = (title, cands) => pick([{ artist: "Ann", title, plays: 9 }], [cands], "gb");
  assert.equal(pickOne("Hi", [c("1", "Hi (Live)"), c("2", "Hi", { explicit: "cleaned" }), c("3", "Hi", { album: "Hits Live at Wembley" }), c("4", "Hi")]).matched[0].id, "4");
  const only = pickOne("Hi", [c("1", "Hi - Live at Wembley"), c("2", "Hi", { explicit: "cleaned" })]);
  assert.equal(only.matched.length, 0);
  assert.equal(only.unmatched[0].onlyLiveOrClean, true);
  assert.equal(pickOne("Hi (Live)", [c("1", "Hi (Live)")]).matched[0].id, "1", "asked for live");
  assert.equal(pickOne("Clean", [c("1", "Clean")]).matched[0].id, "1", "a song called Clean");
});

test("a song with live or clean in its own title still gets the studio version", () => {
  const c = (id, name, extra = {}) => ({ id, name, artistName: "Ann", ...extra });
  const pickOne = (title, cands) => pick([{ artist: "Ann", title, plays: 9 }], [cands], "gb").matched[0]?.id;
  assert.equal(pickOne("Live Forever", [c("1", "Live Forever - Live at Knebworth"), c("2", "Live Forever (Live)"), c("3", "Live Forever")]), "3");
  assert.equal(pickOne("Live Forever", [c("1", "Live Forever", { album: "Definitely Maybe" })]), "1", "'Live' in the title alone is fine");
  assert.equal(pickOne("Live Forever", [c("1", "Live Forever", { album: "Live at Wembley" })]), undefined, "live album");
  assert.equal(pickOne("Clean", [c("1", "Clean (Clean Version)"), c("2", "Clean", { explicit: "cleaned" }), c("3", "Clean")]), "3");
  assert.equal(pickOne("Hi (Live at Wembley)", [c("1", "Hi (Live at Wembley)", { album: "Live at Wembley" })]), "1", "asked for live");
});

test("lookUp keeps searching until a result has no differences", async () => {
  const reply = results => ({ ok: true, status: 200, json: async () => ({ results }) });
  const song = (id, name) => ({ trackId: id, trackName: name, artistName: "Ann" });
  const queries = [];
  const fetchFn = async url => {
    const p = new URL(url).searchParams; queries.push(p.get("limit"));
    return reply(queries.length === 1 ? [song(1, "Hi (Live)")] : [song(1, "Hi (Live)"), song(2, "Hi")]);
  };
  const cache = {};
  const tracks = [{ artist: "Ann", title: "Hi", plays: 9 }];
  const [list] = await lookUp(tracks, { country: "gb", cache, fetchFn, pause: () => {} });
  assert.deepEqual(queries, ["8", "50"], "a wider search, then it stopped");
  assert.equal(pick(tracks, [list], "gb").matched[0].id, "2");
});

test("remaster tags are not differences, other tags are", () => {
  const c = (name) => [{ id: "1", name, artistName: "Ann" }];
  const odd = name => pick([{ artist: "Ann", title: "Hi", plays: 9 }], [c(name)], "gb").matched[0].odd;
  assert.equal(odd("Hi - 2011 Remaster"), false);
  assert.equal(odd("Hi (Remastered 2009)"), false);
  assert.equal(odd("Hi (Remastered)"), false);
  assert.equal(odd("Hi (Acoustic)"), true);
});

test("toManualCsv gives each set-aside song a link", () => {
  const lines = toManualCsv([{ id: "5", artist: "Ann", title: "Hi (Acoustic)", album: "Alb", from: { artist: "Ann", title: "Hi" } }], "gb").trim().split("\n");
  assert.equal(lines[1], "Ann,Hi,Ann,Hi (Acoustic),Alb,https://music.apple.com/gb/song/5,");
  const done = toManualCsv([{ id: "5", artist: "Ann", title: "Hi", album: "", added: true, from: { artist: "Ann", title: "Hi" } }], "gb");
  assert.ok(done.trim().endsWith(",yes"));
});
