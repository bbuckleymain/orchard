// Editing the queue: remove a song, move one, or clear everything that's up next.
// MusicKit JS has no public call to reorder its queue, so an edit is worked out here as a new order of the
// queue's indices, then applied the way Cider does it (rearranging the queue's own item list in place, which
// doesn't touch the song that's playing), and checked. If that isn't possible in this MusicKit, the queue is
// rebuilt in the new order and the playing song carries on from where it was.
//
// Only songs after the one playing are ever moved or removed, so the current song, its position in the queue
// and the history before it stay put, and playback isn't interrupted.

const QueueEdit = (() => {
  const range = n => Array.from({ length: n }, (_, i) => i);
  const upcoming = (n, pos, i) => Number.isInteger(i) && i > pos && i < n;

  // ---- new orders, as lists of old indices; null when the edit makes no sense ----
  function remove(n, pos, i) {
    if (!upcoming(n, pos, i)) return null;
    return range(n).filter(k => k !== i);
  }

  function move(n, pos, from, to) {
    if (!upcoming(n, pos, from) || !upcoming(n, pos, to) || from === to) return null;
    const order = range(n);
    order.splice(to, 0, ...order.splice(from, 1));
    return order;
  }

  function clear(n, pos) {
    if (pos + 1 >= n) return null;
    return range(Math.max(0, pos + 1));
  }

  // Where a dragged song lands when dropped on `target`, in the top (`after` false) or bottom half of that row.
  // Dropping on the song that's playing puts it first in Up Next.
  function dropIndex(pos, from, target, after) {
    if (target <= pos) return pos + 1;
    if (target === from) return from;
    const to = after ? (from < target ? target : target + 1) : (from < target ? target - 1 : target);
    return Math.max(pos + 1, to);
  }

  // ---- applying an order to MusicKit ----
  const idOf = it => it && String(it.id ?? it.attributes?.playParams?.id ?? "");
  const position = music => music.nowPlayingItemIndex ?? music.queue?.position ?? 0;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // `plan(n, pos)` returns the new order. `check` is [index, id] of the row the person acted on, so an edit
  // aimed at a queue that has since moved on is refused instead of hitting the wrong song.
  async function apply(music, plan, check) {
    const q = music?.queue;
    const items = q?.items || [];
    const pos = position(music), ids = items.map(idOf);
    if (check && ids[check[0]] !== String(check[1])) throw new Error("the queue changed, try again");
    const order = plan(items.length, pos);
    if (!order) return false;
    const want = order.map(i => ids[i]);

    // In place: MusicKit keeps the queue as `_queueItems` and works out positions from it in `_reindex()`.
    if (Array.isArray(q._queueItems) && q._queueItems.length === items.length) {
      const before = q._queueItems;
      try {
        q._queueItems = order.map(i => before[i]);
        q._reindex?.();
        if (same((q.items || []).map(idOf), want) && position(music) === pos) return true;
      } catch {}
      try { q._queueItems = before; q._reindex?.(); } catch {}
    }

    // A removal through the queue's own remove(), where there is one.
    const gone = range(items.length).filter(i => !order.includes(i));
    if (typeof q.remove === "function" && gone.length && same(order, range(items.length).filter(i => !gone.includes(i)))) {
      try {
        for (const i of gone.reverse()) q.remove(i);
        if (same((q.items || []).map(idOf), want) && position(music) === pos) return true;
      } catch {}
    }

    // Rebuild the queue in the new order and pick the playing song up where it was.
    if (want.some(id => !id)) throw new Error("this queue can't be edited");
    const time = music.currentPlaybackTime || 0, playing = !!music.isPlaying;
    await music.setQueue({ songs: want, startWith: pos, startPlaying: playing });
    if (time > 0) { try { await music.seekToTime(time); } catch {} }
    return true;
  }

  return { remove, move, clear, dropIndex, apply };
})();

if (typeof module !== "undefined") module.exports = QueueEdit;
