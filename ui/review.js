// The Playlist Reviewer's decisions, kept apart from the DOM so they can be tested. It walks a list once:
// keep moves on, reject moves on and counts as removed, and when the list runs out the review is done.
(function (root) {
  function createReviewer(songs) {
    const list = [...(songs || [])];
    let at = 0, kept = 0, rejected = 0;
    const reviewer = {
      get total() { return list.length; },
      get index() { return at; },
      get current() { return at < list.length ? list[at] : null; },
      get done() { return at >= list.length; },
      get kept() { return kept; },
      get rejected() { return rejected; },
      keep() {
        if (reviewer.done) return null;
        const song = list[at++];
        kept++;
        return song;
      },
      reject() {
        if (reviewer.done) return null;
        const song = list[at++];
        rejected++;
        return song;
      },
    };
    return reviewer;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createReviewer };
  else root.OrchardReview = { createReviewer };
})(typeof globalThis !== "undefined" ? globalThis : this);
