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

test("the reason in a 403 body is reported, not just the status", async () => {
  const fetchFn = async () => ({ ok: false, status: 403, json: async () => ({ error: 10, message: "Invalid API key - You must be granted a valid key by last.fm" }) });
  await assert.rejects(rec.topArtists({ user: "u", key: "bad", fetchFn }), /Invalid API key/);
});

test("checkKey reports a rejected key and stays quiet about a good or unreachable one", async () => {
  const rejected = async () => ({ ok: false, status: 403, json: async () => ({ error: 10, message: "Invalid API key - You must be granted a valid key by last.fm" }) });
  assert.match(await rec.checkKey({ key: "bad", fetchFn: rejected }), /Invalid API key/);
  assert.equal(await rec.checkKey({ key: "ok", fetchFn: json({ artists: { artist: [] } }) }), "");
  const offline = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  assert.equal(await rec.checkKey({ key: "ok", fetchFn: offline }), "", "being offline is not a bad key");
});

test("similarArtists drops the seeds and keeps the best match for a repeat", async () => {
  const replies = {
    "artist=A&": { similarartists: { artist: [artist("X", 0.9), artist("B", 0.8), artist("Y", 0.4)] } },
    "artist=B&": { similarartists: { artist: [artist("X", 0.5), artist("Z", 0.7)] } },
  };
  const fetchFn = async url => json(replies[Object.keys(replies).find(k => url.includes(k))])();
  const out = await rec.similarArtists({ seeds: [{ name: "A" }, { name: "B" }], key: "k", exclude: ["Y"], fetchFn });
  assert.deepEqual(out.map(a => a.name), ["X", "Z"]);
  assert.equal(out[0].match, 0.9, "the higher of X's two scores wins");
});

test("a seed Last.fm can't find doesn't sink the list", async () => {
  const fetchFn = async url => url.includes("artist=Bad")
    ? json({ error: 6, message: "Artist not found" })()
    : json({ similarartists: { artist: [artist("Good", 0.5)] } })();
  const out = await rec.similarArtists({ seeds: [{ name: "Bad" }, { name: "Ok" }], key: "k", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Good"]);
});

test("topTags drops noise tags and keeps the genre ones", async () => {
  const fetchFn = json({ toptags: { tag: [
    { name: "post-hardcore", count: 100 }, { name: "seen live", count: 90 },
    { name: "emo", count: 80 }, { name: "Favorites", count: 70 }, { name: "math rock", count: 60 },
  ] } });
  const out = await rec.topTags({ user: "u", key: "k", limit: 2, fetchFn });
  assert.deepEqual(out.map(t => t.name), ["post-hardcore", "emo"]);
});

test("artistsByTags weighs the first tag highest and skips artists you already play", async () => {
  const replies = {
    "tag=post-hardcore": { topartists: { artist: [{ name: "Saosin" }, { name: "Emery" }, { name: "Known" }] } },
    "tag=emo": { topartists: { artist: [{ name: "Pool Kids" }, { name: "Saosin" }] } },
  };
  const fetchFn = async url => json(replies[Object.keys(replies).find(k => url.includes(k))])();
  const out = await rec.artistsByTags({
    tags: [{ name: "post-hardcore" }, { name: "emo" }], key: "k", exclude: ["Known"], fetchFn,
  });
  assert.deepEqual(out.map(a => a.name), ["Saosin", "Emery", "Pool Kids"]);
  assert.equal(out[0].tag, "post-hardcore", "the shared artist is credited to the heavier tag");
});

test("a tag chart that fails is skipped, not fatal", async () => {
  const fetchFn = async url => url.includes("tag=bad")
    ? json({ error: 6, message: "Tag not found" })()
    : json({ topartists: { artist: [{ name: "Fine" }] } })();
  const out = await rec.artistsByTags({ tags: [{ name: "bad" }, { name: "good" }], key: "k", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Fine"]);
});

test("recommendArtists uses the neighbours of the artists you play, minus your library", async () => {
  const seen = [];
  const fetchFn = async url => {
    const q = new URL(url).searchParams;
    const m = q.get("method");
    seen.push(m);
    if (m === "user.gettopartists") return json({ topartists: { artist: [{ name: "UnderOath" }, { name: "Origami Angel" }] } })();
    if (m === "artist.getsimilar") {
      const who = q.get("artist");
      if (who === "UnderOath") return json({ similarartists: { artist: [
        { name: "Saosin", match: "0.9" }, { name: "Emery", match: "0.8" }, { name: "Origami Angel", match: "0.7" },
      ] } })();
      return json({ similarartists: { artist: [{ name: "Pool Kids", match: "0.85" }, { name: "Saosin", match: "0.6" }] } })();
    }
    if (m === "user.gettoptags") return json({ toptags: { tag: [] } })();
    return json({});
  };
  const out = await rec.recommendArtists({ user: "u", key: "k", known: ["Emery"], fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Saosin", "Pool Kids"]);
  assert.ok(seen.includes("artist.getsimilar"), "walks the similar-artist graph");
  assert.ok(!seen.includes("tag.gettopartists"), "no tag charts when the neighbours are enough");
});

test("recommendArtists falls back to similar artists with no username", async () => {
  const fetchFn = async url => {
    const m = new URL(url).searchParams.get("method");
    if (m === "chart.gettopartists") return json({ artists: { artist: [{ name: "Seed" }] } })();
    return json({ similarartists: { artist: [artist("Neighbour", 0.8)] } })();
  };
  const out = await rec.recommendArtists({ user: "", key: "k", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Neighbour"]);
});

test("signedCall signs the sorted parameters plus the secret, without format or api_sig", async () => {
  const crypto = require("node:crypto");
  let seen;
  const fetchFn = async url => { seen = new URL(url); return json({ ok: 1 })(); };
  await rec.recommendedArtists({ key: "KEY", secret: "SECRET", sk: "SK", user: "u", limit: 3, fetchFn });
  const q = seen.searchParams;
  const signed = { api_key: "KEY", limit: "3", method: "user.getRecommendedArtists", sk: "SK", user: "u" };
  const base = Object.keys(signed).sort().map(k => k + signed[k]).join("");
  const expected = crypto.createHash("md5").update(base + "SECRET").digest("hex");
  assert.equal(q.get("api_sig"), expected);
  assert.equal(q.get("format"), "json");
  assert.equal(q.get("sk"), "SK");
});

test("authGetToken and authGetSession read Last.fm's two auth replies", async () => {
  const token = await rec.authGetToken({ key: "K", secret: "S", fetchFn: json({ token: "tok" }) });
  assert.deepEqual(token, { token: "tok" });
  const session = await rec.authGetSession({
    key: "K", secret: "S", token: "tok",
    fetchFn: json({ session: { name: "twocan2580", key: "sess" } }),
  });
  assert.deepEqual(session, { name: "twocan2580", key: "sess" });
});

test("recommendedArtists returns Last.fm's own suggestions", async () => {
  const fetchFn = json({ recommendations: { artist: [{ name: "Saosin" }, { name: "Emery" }, { name: "" }] } });
  const out = await rec.recommendedArtists({ key: "K", secret: "S", sk: "SK", user: "u", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Saosin", "Emery"]);
});

test("recommendArtists prefers the signed suggestions when connected", async () => {
  const seen = [];
  const fetchFn = async url => {
    const m = new URL(url).searchParams.get("method");
    seen.push(m);
    if (m === "user.getRecommendedArtists") return json({ recommendations: { artist: [{ name: "Own" }] } })();
    return json({})();
  };
  const out = await rec.recommendArtists({ user: "u", key: "K", secret: "S", sk: "SK", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Own"]);
  assert.deepEqual(seen, ["user.getRecommendedArtists"], "no genre charts are read");
});

test("recommendArtists tops up from the genre charts when the neighbours are thin", async () => {
  const fetchFn = async url => {
    const m = new URL(url).searchParams.get("method");
    if (m === "user.getRecommendedArtists") return json({ error: 9, message: "Invalid session key" })();
    if (m === "user.gettopartists") return json({ topartists: { artist: [{ name: "Known" }] } })();
    if (m === "artist.getsimilar") return json({ similarartists: { artist: [{ name: "Near", match: "0.5" }] } })();
    if (m === "user.gettoptags") return json({ toptags: { tag: [{ name: "emo", count: 4 }] } })();
    return json({ topartists: { artist: [{ name: "Chart" }] } })();
  };
  const out = await rec.recommendArtists({ user: "u", key: "K", secret: "S", sk: "old", fetchFn });
  assert.deepEqual(out.map(a => a.name), ["Near", "Chart"]);
});

test("artistFromHref and albumFromHref read the Suggested page's links, skipping Last.fm's own", () => {
  assert.equal(rec.artistFromHref("/music/Saosin"), "Saosin");
  assert.equal(rec.artistFromHref("/music/Michael+Cera+Palin"), "Michael Cera Palin");
  assert.equal(rec.artistFromHref("/music/+recommended/albums"), "", "navigation is not a suggestion");
  assert.equal(rec.artistFromHref("/music/%E2%80%8E"), "");
  assert.deepEqual(rec.albumFromHref("/music/Saosin/Saosin"), { title: "Saosin", artist: "Saosin" });
  assert.deepEqual(rec.albumFromHref("/music/156%2FSilence/Narrative"), { title: "Narrative", artist: "156/Silence" });
  assert.equal(rec.albumFromHref("/music/Saosin"), null, "an artist link is not an album");
  assert.equal(rec.albumFromHref("/music/+free-music-downloads/x"), null);
});

test("albumTracks and artistTopTracks ask Apple for songs, not for the album or artist itself", async () => {
  const urls = [];
  const fetchFn = async url => { urls.push(url); return json({ data: [] })(); };
  await rec.albumTracks("123", { token: "t", storefront: "us", fetchFn });
  await rec.artistTopTracks("456", { token: "t", storefront: "us", fetchFn });
  assert.match(urls[0], /\/v1\/catalog\/us\/albums\/123\/tracks\?/);
  assert.match(urls[1], /\/v1\/catalog\/us\/artists\/456\/view\/top-songs\?/);
});

test("buildSuggestedTracks ignores anything that isn't a streamable song", async () => {
  const song = id => ({ id, type: "songs", attributes: { name: id, playParams: { id } } });
  const album = { id: "alb", type: "albums", attributes: { name: "An album" } };
  const fetchFn = async url => json({ data: url.includes("/albums/") ? [album, song("s1")] : [] })();
  const out = await rec.buildSuggestedTracks({ albums: [{ found: true, apple: { id: "alb" } }], token: "t", storefront: "us", fetchFn });
  assert.deepEqual(out.map(t => t.id), ["s1"]);
});

test("buildSuggestedTracks fills a 100-song playlist by default", async () => {
  const song = id => ({ id, type: "songs", attributes: { name: id, playParams: { id } } });
  const fetchFn = async url => {
    const m = /\/albums\/(\w+)\/tracks/.exec(url);
    return json({ data: Array.from({ length: 50 }, (_, i) => song(`${m[1]}${i}`)) })();
  };
  const albums = ["a", "b", "c"].map(id => ({ found: true, apple: { id } }));
  const out = await rec.buildSuggestedTracks({ albums, token: "t", storefront: "us", fetchFn });
  assert.equal(out.length, 100);
  assert.equal(new Set(out.map(t => t.id)).size, 100, "no repeats");
});

test("matchSongs matches on the title and ignores 'feat.' credits", async () => {
  const song = (id, name, artistName) => ({ id, type: "songs", attributes: { name, artistName, playParams: { id } } });
  const fetchFn = async url => {
    const term = new URL(url).searchParams.get("term");
    if (term.startsWith("Flower In A Hurricane")) return json({ results: { songs: { data: [song("1", "Flower In A Hurricane", "Justice")] } } })();
    if (term.startsWith("Unknown")) return json({ results: { songs: { data: [] } } })();
    return json({ results: { songs: { data: [song("2", "Something Else", "Other")] } } })();
  };
  const out = await rec.matchSongs([
    { title: "Flower In A Hurricane (feat. Tame Impala)", artist: "Justice" },
    { title: "Unknown", artist: "Nobody" },
    { title: "Other Song", artist: "Someone" },
  ], { token: "t", storefront: "us", fetchFn });
  assert.deepEqual(out.map(m => m.found), [true, false, true]);
  assert.equal(out[0].apple.id, "1");
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
