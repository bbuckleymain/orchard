// Queue editing (ui/queue.js): the orders it works out, and how they're applied to a MusicKit-like queue.
const test = require("node:test");
const assert = require("node:assert/strict");
const QueueEdit = require("../ui/queue.js");

test("remove takes out one upcoming song only", () => {
  assert.deepEqual(QueueEdit.remove(5, 1, 3), [0, 1, 2, 4]);
  assert.equal(QueueEdit.remove(5, 1, 1), null, "not the song that's playing");
  assert.equal(QueueEdit.remove(5, 1, 0), null, "not history");
  assert.equal(QueueEdit.remove(5, 1, 5), null, "not past the end");
});

test("move rearranges Up Next and leaves the playing song where it is", () => {
  assert.deepEqual(QueueEdit.move(5, 1, 4, 2), [0, 1, 4, 2, 3]);
  assert.deepEqual(QueueEdit.move(5, 1, 2, 4), [0, 1, 3, 4, 2]);
  assert.equal(QueueEdit.move(5, 1, 2, 1), null);
  assert.equal(QueueEdit.move(5, 1, 1, 3), null);
  assert.equal(QueueEdit.move(5, 1, 3, 3), null);
});

test("clear keeps the history and the playing song", () => {
  assert.deepEqual(QueueEdit.clear(5, 1), [0, 1]);
  assert.deepEqual(QueueEdit.clear(5, 0), [0]);
  assert.equal(QueueEdit.clear(2, 1), null, "nothing up next");
});

test("dropIndex places a dragged song before or after the row it's dropped on", () => {
  // queue 0..6, playing 1
  assert.equal(QueueEdit.dropIndex(1, 5, 3, false), 3);   // up, top half
  assert.equal(QueueEdit.dropIndex(1, 5, 3, true), 4);    // up, bottom half
  assert.equal(QueueEdit.dropIndex(1, 2, 5, false), 4);   // down, top half
  assert.equal(QueueEdit.dropIndex(1, 2, 5, true), 5);    // down, bottom half
  assert.equal(QueueEdit.dropIndex(1, 5, 1, true), 2);    // onto Now Playing: first in Up Next
  assert.equal(QueueEdit.dropIndex(1, 2, 2, true), 2);    // onto itself
});

// A stand-in for MusicKit's instance and queue, as far as these edits use them.
function fakeMusic(ids, pos, { internal = true, remove = false } = {}) {
  const calls = [];
  const music = {
    nowPlayingItemIndex: pos, currentPlaybackTime: 42, isPlaying: true, calls,
    async setQueue(o) { calls.push(["setQueue", o]); music.queue._queueItems = o.songs.map(id => ({ item: { id } })); },
    async seekToTime(t) { calls.push(["seek", t]); },
  };
  music.queue = {
    _queueItems: ids.map(id => ({ item: { id } })),
    get items() { return this._queueItems.map(q => q.item); },
    get position() { return music.nowPlayingItemIndex; },
  };
  if (internal) music.queue._reindex = () => calls.push(["reindex"]);
  else Object.defineProperty(music.queue, "_queueItems", { value: music.queue._queueItems, writable: false });
  if (remove) music.queue.remove = i => { calls.push(["remove", i]); music.queue._queueItems.splice(i, 1); };
  return music;
}
const idsOf = m => m.queue.items.map(i => i.id);

test("apply rearranges the queue in place without restarting the song", async () => {
  const m = fakeMusic(["a", "b", "c", "d", "e"], 1);
  assert.equal(await QueueEdit.apply(m, (n, pos) => QueueEdit.move(n, pos, 4, 2), [4, "e"]), true);
  assert.deepEqual(idsOf(m), ["a", "b", "e", "c", "d"]);
  assert.deepEqual(m.calls, [["reindex"]]);
  assert.equal(m.nowPlayingItemIndex, 1);
});

test("apply clears Up Next in place", async () => {
  const m = fakeMusic(["a", "b", "c", "d"], 1);
  await QueueEdit.apply(m, QueueEdit.clear);
  assert.deepEqual(idsOf(m), ["a", "b"]);
});

test("apply refuses an edit aimed at a queue that has changed", async () => {
  const m = fakeMusic(["a", "b", "c"], 0);
  await assert.rejects(QueueEdit.apply(m, (n, pos) => QueueEdit.remove(n, pos, 2), [2, "z"]), /queue changed/);
  assert.deepEqual(idsOf(m), ["a", "b", "c"]);
});

test("apply does nothing for an edit that makes no sense", async () => {
  const m = fakeMusic(["a", "b"], 1);
  assert.equal(await QueueEdit.apply(m, QueueEdit.clear), false);
  assert.deepEqual(m.calls, []);
});

test("apply uses the queue's own remove() when it can't rearrange in place", async () => {
  const m = fakeMusic(["a", "b", "c", "d"], 0, { internal: false, remove: true });
  await QueueEdit.apply(m, (n, pos) => QueueEdit.remove(n, pos, 2), [2, "c"]);
  assert.deepEqual(idsOf(m), ["a", "b", "d"]);
  assert.deepEqual(m.calls, [["remove", 2]]);
});

test("apply rebuilds the queue and resumes the song when nothing else works", async () => {
  const m = fakeMusic(["a", "b", "c", "d"], 1, { internal: false });
  await QueueEdit.apply(m, (n, pos) => QueueEdit.move(n, pos, 3, 2), [3, "d"]);
  assert.deepEqual(m.calls, [
    ["setQueue", { songs: ["a", "b", "d", "c"], startWith: 1, startPlaying: true }],
    ["seek", 42],
  ]);
});
