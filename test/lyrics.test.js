// Lyrics parsing (ui/lyrics.js) and the converters/matcher behind the outside sources.
const test = require("node:test");
const assert = require("node:assert/strict");
const Lyrics = require("../ui/lyrics.js");
const { richsyncToLrc, matches } = require("../musixmatch.js");
const { neteaseToLrc } = require("../lyrics-sources.js");

test("parseLRC reads line and word timings and sorts by start", () => {
  const r = Lyrics.parseLRC("[00:05.00] <00:05.00> hi <00:05.50> there <00:06.00>\n[00:01.50]first");
  assert.equal(r.synced, true);
  assert.equal(r.worded, true);
  assert.deepEqual(r.lines.map(l => l.text), ["first", "hi there"]);
  assert.deepEqual(r.lines[1].words.map(w => [w.text, w.start, w.end]), [["hi", 5, 5.5], ["there", 5.5, 6]]);
});

test("parseLRC treats text with no stamps as plain, and applies the offset tag", () => {
  assert.equal(Lyrics.parseLRC("just words").synced, false);
  assert.equal(Lyrics.parseLRC("[offset:500]\n[00:10.00]x").lines[0].start, 9.5);
});

test("withRests adds a break for a long gap", () => {
  const line = (start, end) => ({ start, end, text: "x", words: [], bg: [] });
  const out = Lyrics.withRests([line(10, 12), line(30, 32)]);
  assert.deepEqual(out.filter(l => l.rest).map(l => l.rest), [[0, 10], [12, 30]]);
});

test("richsyncToLrc stamps each word and closes the line", () => {
  const body = JSON.stringify([{ ts: 1, te: 3, l: [{ c: "hi", o: 0 }, { c: " ", o: 0.4 }, { c: "you", o: 0.5 }] }]);
  assert.equal(richsyncToLrc(body), "[00:01.00] <00:01.00> hi <00:01.50> you <00:03.00>");
  assert.equal(richsyncToLrc("not json"), "");
});

test("neteaseToLrc skips the credit line and joins punctuation to its word", () => {
  const yrc = "[0,500](0,200,0)作词: x\n[1000,900](1000,400,0)Hi(1400,300,0),(1700,200,0) you";
  assert.equal(neteaseToLrc(yrc), "[00:01.00] <00:01.00> Hi, <00:01.70> you <00:01.90>");
});

test("matches accepts the same song and rejects another", () => {
  assert.equal(matches("Love Story", "Taylor Swift", 235, "Love Story", "Taylor Swift", 236), true);
  assert.equal(matches("Love Me Do", "The Beatles", 140, "Love Story", "Taylor Swift", 236), false);
  assert.equal(matches("Love Story", "Taylor Swift", 400, "Love Story", "Taylor Swift", 236), false, "wrong length");
  assert.equal(matches("K.", "Cigarettes After Sex", 0, "K.", "Cigarettes After Sex", 0), true, "one-letter title");
  assert.equal(matches("Apocalypse", "Cigarettes After Sex", 0, "K.", "Cigarettes After Sex", 0), false);
});
