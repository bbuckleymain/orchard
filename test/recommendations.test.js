const test = require("node:test");
const assert = require("node:assert/strict");
const rec = require("../recommendations.js");

const json = body => async () => ({ ok: true, status: 200, json: async () => body });
const artist = (name, match) => ({ name, match: String(match) });

test("norm ignores case, accents and edition suffixes", () => {
  assert.equal(rec.norm("Björk"), "bjork");
  assert.equal(rec.norm("Homogenic (Remastered 2011)"), "homogenic");
  assert.equal(rec.norm("Song - Radio Edit"), "song");
});

test("topArtists reads a user's most-played artists", async () => {
  const fetchFn = json({ topartists: { artist: [{ name: "A", playcount: "30" }, { name: "B", playcount: "9" }] } });
  const out = await rec.topArtists({ user: "u", key: "k", fetchFn });
  assert.deepEqual(out, [{ name: "A", plays: 30 }, { name: "B", plays: 9 }]);
});

test("topArtists falls back to the charts with no username", async () => {
  const fetchFn = json({ artists: { artist: [{ name: "Chart", playcount: "100" }] } });
  assert.deepEqual(await rec.topArtists({ user: "", key: "k", fetchFn }), [{ name: "Chart", plays: 100 }]);
});

test("a Last.fm error becomes an Error", async () => {
  await assert.rejects(rec.topArtists({ user: "u", key: "k", fetchFn: json({ error: 6, message: "User not found" }) }), /User not found/);
});

test("similarArtists drops the seeds and keeps the best match for a repeat", async () => {
  const replies = {
    "artist=A&": { similarartists: { artist: [artist("X", 0.9), artist("B", 0.8), artist("Y", 0.4)] } },
    "artist=B&": { similarartists: { artist: [artist("X", 0.5), artist("Z", 0.7)] } },
  };
  const fetchFn = async url => json(replies[Object.keys(replies).find(k => url.includes(k))])();
  const out = await rec.similarArtists({ seeds: [{ name: "A" }, { name: "B" }], key: "k", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["X", "Z", "Y"]);
  assert.equal(out[0].match, 0.9, "the higher of X's two scores wins");
});

test("a seed Last.fm can't find doesn't sink the list", async () => {
  const fetchFn = async url => url.includes("artist=Bad")
    ? json({ error: 6, message: "Artist not found" })()
    : json({ similarartists: { artist: [artist("Good", 0.5)] } })();
  const out = await rec.similarArtists({ seeds: [{ name: "Bad" }, { name: "Ok" }], key: "k", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Good"]);
});

test("albumsByArtists skips compilations and repeats", async () => {
  const replies = {
    "artist=One": { topalbums: { album: [{ name: "Greatest Hits" }, { name: "First" }, { name: "Second" }, { name: "Third" }] } },
    "artist=Two": { topalbums: { album: [{ name: "First" }, { name: "Other" }] } },
  };
  const fetchFn = async url => json(replies[Object.keys(replies).find(k => url.includes(k))])();
  const out = await rec.albumsByArtists({ artists: [{ name: "One" }, { name: "Two" }], key: "k", perArtist: 2, fetchFn });
  assert.deepEqual(out, [{ title: "First", artist: "One" }, { title: "Second", artist: "One" }, { title: "Other", artist: "Two" }]);
});

test("matchAlbums prefers an exact title and artist, then a title match, then the first result", async () => {
  const album = (id, name, artistName) => ({ id, type: "albums", attributes: { name, artistName } });
  const results = {
    "Exact Artist": [album("1", "Exact", "Someone Else"), album("2", "Exact", "Artist")],
    "Title Only": [album("3", "Something", "X"), album("4", "Title", "Other")],
    "Nothing Here": [album("5", "Nearest", "Whoever")],
  };
  const fetchFn = async url => {
    const term = new URL(url).searchParams.get("term");
    return json({ results: { albums: { data: results[term] || [] } } })();
  };
  const out = await rec.matchAlbums(
    [{ title: "Exact", artist: "Artist" }, { title: "Title", artist: "Only" }, { title: "Nothing", artist: "Here" }],
    { token: "t", storefront: "us", fetchFn });
  assert.deepEqual(out.map(a => a.apple?.id), ["2", "4", "5"]);
  assert.ok(out.every(a => a.found));
});

test("buildSuggestedTracks adds each song once and stops at the limit", async () => {
  const song = id => ({ id, type: "songs", attributes: { name: id, playParams: { id } } });
  const fetchFn = async url => {
    if (url.includes("/albums/")) return json({ data: [song("a1"), song("a2")] })();
    if (url.includes("/top-songs")) return json({ data: [song("a2"), song("b1")] })();
    return json({ data: [] })();
  };
  const albums = [{ found: true, apple: { id: "alb" } }];
  const artists = [{ found: true, apple: { id: "art" } }];
  const out = await rec.buildSuggestedTracks({ albums, artists, token: "t", storefront: "us", fetchFn, maxTracks: 3 });
  assert.deepEqual(out.map(t => t.id), ["a1", "a2", "b1"]);
});

test("buildSuggestedTracks spreads the songs across albums instead of filling up on the first one", async () => {
  const song = id => ({ id, type: "songs", attributes: { name: id, playParams: { id } } });
  const fetchFn = async url => {
    if (url.includes("/albums/one")) return json({ data: Array.from({ length: 10 }, (_, i) => song(`one${i}`)) })();
    if (url.includes("/albums/two")) return json({ data: [song("two0"), song("two1")] })();
    return json({ data: [] })();
  };
  const albums = [{ found: true, apple: { id: "one" } }, { found: true, apple: { id: "two" } }];
  const out = await rec.buildSuggestedTracks({ albums, token: "t", storefront: "us", fetchFn, maxTracks: 5 });
  assert.deepEqual(out.map(t => t.id), ["one0", "one1", "one2", "two0", "two1"]);
});
