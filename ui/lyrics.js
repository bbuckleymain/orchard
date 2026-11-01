// Synced lyrics, in the manner of Aeris and Cider.
// Sources, best first: Apple Music's own lyrics (timed by the syllable), NetEase (by the word), LRCLIB (by the line).
// Every source becomes the same shape:
//   line = { start, end, text, words: [{ start, end, text, join }], bg: [words], agent, rest: [from, to] | null }
// where `join` means the next syllable belongs to the same word (no space between).

const Lyrics = (() => {
  const REST = 5.0, WORD_TIME = 0.55, LEAST_SUNG = 3.0, MOST_SUNG = 12.0, LINGER = 0.35;   // from Aeris

  // "14.865", "1:02.5", "1:02:03.4", "12.3s"
  function clock(t) {
    if (t == null || t === "") return null;
    t = String(t).trim().replace(/s$/, "");
    return t.split(":").reduce((acc, part) => acc * 60 + parseFloat(part), 0);
  }

  // ---- Apple Music TTML ----
  function parseTTML(ttml) {
    const doc = new DOMParser().parseFromString(ttml, "application/xml");
    const timing = doc.documentElement.getAttribute("itunes:timing") || "";
    const lines = [];
    for (const p of doc.getElementsByTagName("p")) {
      const words = [], bg = [];
      const walk = (node, into) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {                       // text between spans: a space means a new word
            if (/\s/.test(child.nodeValue) && into.length) into[into.length - 1].join = false;
            continue;
          }
          if (child.nodeName !== "span") continue;
          if ((child.getAttribute("ttm:role") || "").includes("bg")) { walk(child, bg); continue; }
          const begin = clock(child.getAttribute("begin"));
          if (begin == null) { walk(child, into); continue; }
          const text = child.textContent;
          if (!text.trim()) continue;
          into.push({ start: begin, end: clock(child.getAttribute("end")), text: text.trim(), join: true });
        }
        if (into.length) into[into.length - 1].join = false;
      };
      walk(p, words);
      const start = clock(p.getAttribute("begin")), end = clock(p.getAttribute("end"));
      const text = words.length ? spoken(words) : p.textContent.trim();
      if (!text && !bg.length) continue;
      lines.push({ start, end, text, words: timing === "Word" ? words : [], bg: timing === "Word" ? bg : [], agent: p.getAttribute("ttm:agent") || "v1", rest: null });
    }
    const synced = timing !== "None" && lines.some(l => l.start != null);
    return { lines: synced ? lines : lines.map(l => ({ ...l, start: null, end: null })), synced, worded: timing === "Word" };
  }

  // ---- LRC, plain or enhanced (Aeris's parse_lrc) ----
  const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const WORD_STAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  const ID_TAG = /^\s*\[(ar|ti|al|au|by|re|ve|length|offset|tool|encoder):([^\]]*)\]\s*$/i;
  const secs = (m, s, f = "0") => +m * 60 + +s + +f / 10 ** f.length;

  function parseLRC(text) {
    let offset = 0;
    const timed = [], plain = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const tag = raw.match(ID_TAG);
      if (tag) { if (tag[1].toLowerCase() === "offset") offset = -(parseFloat(tag[2]) || 0) / 1000; continue; }
      const stamps = [...raw.matchAll(STAMP)];
      if (!stamps.length) { if (raw.trim()) plain.push(raw.trim()); continue; }
      const rest = raw.slice(stamps[stamps.length - 1].index + stamps[stamps.length - 1][0].length);
      const marks = [...rest.matchAll(WORD_STAMP)];
      const words = [];
      let end = null;
      marks.forEach((m, i) => {
        const stop = i + 1 < marks.length ? marks[i + 1].index : rest.length;
        const t = rest.slice(m.index + m[0].length, stop).trim();
        const at = Math.max(0, secs(m[1], m[2], m[3]) + offset);
        if (!t) { end = at; return; }
        if (words.length) words[words.length - 1].end = at;
        words.push({ start: at, end: null, text: t, join: false });
      });
      if (words.length && end != null) words[words.length - 1].end = end;
      const said = (words.length ? spoken(words) : rest.replace(WORD_STAMP, " ")).replace(/\s{2,}/g, " ").trim();
      for (const s of stamps)
        timed.push({ start: Math.max(0, secs(s[1], s[2], s[3]) + offset), end, text: said, words, bg: [], agent: "v1", rest: null });
    }
    if (timed.length) {
      timed.sort((a, b) => a.start - b.start);
      return { lines: timed, synced: true, worded: timed.some(l => l.words.length) };
    }
    return { lines: plain.map(t => ({ start: null, end: null, text: t, words: [], bg: [], agent: "v1", rest: null })), synced: false, worded: false };
  }

  const spoken = words => words.map((w, i) => w.text + (w.join || i === words.length - 1 ? "" : " ")).join("");

  // ---- instrumental breaks (Aeris's with_rests) ----
  function stopsAt(line, next) {
    if (line.end != null) return line.end;
    if (line.start == null) return null;
    if (line.words.length) return line.words[line.words.length - 1].start + WORD_TIME;
    let held = Math.max(LEAST_SUNG, Math.min(line.text.split(/\s+/).length * WORD_TIME, MOST_SUNG));
    if (next != null) held = Math.max(held, Math.min(LINGER * (next - line.start), MOST_SUNG));
    return line.start + held;
  }

  function withRests(lines) {
    const out = [];
    lines.forEach((line, i) => {
      if (i === 0 && line.start >= REST) out.push({ start: 0, end: line.start, text: "", words: [], bg: [], rest: [0, line.start] });
      out.push(line);
      const next = lines[i + 1];
      if (!next) return;
      const stops = stopsAt(line, next.start);
      if (stops != null && next.start - stops >= REST) out.push({ start: stops, end: next.start, text: "", words: [], bg: [], rest: [stops, next.start] });
    });
    return out;
  }

  // ---- fetching ----
  const cache = new Map();

  async function apple(music, catalogId) {
    const sf = music.storefrontId || "us";
    const lang = encodeURIComponent(navigator.language || "en-US");
    const headers = { Authorization: "Bearer " + music.developerToken, "media-user-token": music.musicUserToken || "" };
    for (const [kind, attr] of [["syllable-lyrics", "ttmlLocalizations"], ["lyrics", "ttml"]]) {
      try {
        const r = await fetch(`https://amp-api.music.apple.com/v1/catalog/${sf}/songs/${catalogId}/${kind}?l%5Blyrics%5D=${lang}&extend=ttmlLocalizations&l%5Bscript%5D=en-Latn`, { headers });
        if (!r.ok) continue;
        const a = (await r.json()).data?.[0]?.attributes;
        const ttml = a?.[attr] || a?.ttml || a?.ttmlLocalizations;
        if (ttml) {
          const parsed = parseTTML(ttml);
          if (parsed.lines.length) return { ...parsed, source: "Apple Music" };
        }
      } catch {}
    }
    return null;
  }

  // The best lyrics for the item playing now.
  async function find(music, item, { wordSync = true } = {}) {
    const a = item.attributes || {};
    const catalogId = a.playParams?.catalogId || (/^\d+$/.test(String(item.id)) ? String(item.id) : null);
    const key = (catalogId || item.id) + (wordSync ? ":w" : ":l");
    if (cache.has(key)) return cache.get(key);
    let found = null;
    if (catalogId && a.hasLyrics !== false && music.isAuthorized) {
      found = await apple(music, catalogId);
      if (found && !wordSync) found = { ...found, lines: found.lines.map(l => ({ ...l, words: [], bg: [] })), worded: false };
    }
    if (!found || !found.synced) {
      const ext = await glass.lyrics({ artist: a.artistName || item.artistName, title: a.name || item.title, album: a.albumName || "",
                                       duration: (a.durationInMillis || item.playbackDuration || 0) / 1000, wordSync });
      if (ext) {
        const parsed = parseLRC(ext.text);
        if (parsed.lines.length && (!found || parsed.synced)) found = { ...parsed, source: ext.source };
      }
    }
    if (found?.synced) found.lines = withRests(found.lines);
    cache.set(key, found);
    return found;
  }

  return { find, parseTTML, parseLRC, withRests };
})();
