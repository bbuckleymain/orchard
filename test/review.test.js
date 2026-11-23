const test = require("node:test");
const assert = require("node:assert/strict");
const { createReviewer } = require("../ui/review.js");

const songs = ["a", "b", "c"].map(id => ({ id, title: id }));

test("walks the list once and counts each decision", () => {
  const r = createReviewer(songs);
  assert.equal(r.current.id, "a");
  assert.equal(r.total, 3);
  assert.equal(r.index, 0);

  assert.equal(r.keep().id, "a");
  assert.equal(r.current.id, "b");
  assert.equal(r.reject().id, "b");
  assert.equal(r.keep().id, "c");

  assert.equal(r.done, true);
  assert.equal(r.current, null);
  assert.equal(r.kept, 2);
  assert.equal(r.rejected, 1);
});

test("decisions after the end do nothing", () => {
  const r = createReviewer([songs[0]]);
  r.keep();
  assert.equal(r.done, true);
  assert.equal(r.keep(), null);
  assert.equal(r.reject(), null);
  assert.equal(r.kept, 1);
  assert.equal(r.rejected, 0);
});

test("an empty playlist is done from the start", () => {
  const r = createReviewer([]);
  assert.equal(r.done, true);
  assert.equal(r.total, 0);
  assert.equal(r.current, null);
});

test("the reviewer works on its own copy of the list", () => {
  const list = [...songs];
  const r = createReviewer(list);
  r.keep();
  assert.equal(list.length, 3);
});
