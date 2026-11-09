// Musixmatch, through its official API and a key of your own. Ported from Aerwave (aerwave/musixmatch.py).
//
// Musixmatch has the most complete set of timed lyrics there is: line by line for most songs and word by
// word ("richsync") for many. The catch is the plan. A free developer key gets 30% of each song's words and
// no timings, which is no use to a lyrics view and is never used here; timed lyrics come with the paid
// plans. So this asks for the best the key allows (richsync, then line-timed subtitles), and when the key
// or plan is the problem it says so once and stops asking, rather than being told the same for every song.
//
// A match has to look like the track before it is used: a word-timed lyric for the wrong song is worse
// than none.

const API = "https://api.musixmatch.com/ws/1.1/";
const AGENT = "Orchard/1.0 (desktop music player)";
const TIMEOUT = 10000;
const CLOSE_ENOUGH = 8;          // seconds of difference still counted as the same track
const NOTICE = /\*{3,}.*\*{3,}|not for commercial use/i;   // lines Musixmatch adds on cheaper plans

class PlanError extends Error {}

async function ask(method, key, params) {
  const query = new URLSearchParams({ ...params, apikey: key, format: "json" });
  let message;
  try {
    const r = await fetch(API + method + "?" + query, { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(TIMEOUT) });
    message = (await r.json()).message || {};
  } catch { return null; }                                   // offline or garbled: try again another time
  const status = +(message.header?.status_code || 0);
  if (status === 200) return message.body && typeof message.body === "object" ? message.body : null;
  if (status === 401) throw new PlanError("Musixmatch did not accept the API key");
  if (status === 402) throw new PlanError("the Musixmatch key has used up its allowance for now");
  if (status === 403) throw new PlanError("the Musixmatch plan does not include timed lyrics");
  return null;                                               // 404 and friends: not on Musixmatch
}

const wordsOf = text => new Set((String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 1));
const overlaps = (a, b) => [...a].some(w => b.has(w));

// Does a result from any lyrics source look like the song that's playing? Lengths are in seconds.
function matches(foundTitle, foundArtist, foundLength, title, artist, duration) {
  const wanted = wordsOf(title), found = wordsOf(foundTitle);
  if (!wanted.size || !overlaps(wanted, found)) return false;
  if ([...wanted].filter(w => !found.has(w)).length > wanted.size / 2) return false;
  const who = wordsOf(artist);
  if (who.size && !overlaps(who, wordsOf(foundArtist))) return false;
  return !(duration && foundLength && Math.abs(foundLength - duration) > CLOSE_ENOUGH);
}

function stamp(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100)), whole = Math.floor(cs / 100);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

// Richsync arrives as [{ ts: start, te: end, l: [{ c: text, o: offset }, …] }, …] where the pieces are words
// and the spaces between them, timed from the start of the line. It becomes enhanced LRC: every word stamped,
// and the line closed with its end so the lyrics view can tell an instrumental break from a breath.
function richsyncToLrc(body) {
  let lines;
  try { lines = JSON.parse(body); } catch { return ""; }
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const start = +(line.ts || 0), end = +(line.te || 0);
    const words = [];
    let gap = true;
    for (const piece of line.l || []) {
      const text = String(piece.c ?? "");
      const when = start + +(piece.o || 0);
      if (!text.trim()) { gap = true; continue; }
      if (gap || !words.length) words.push([when, text]);
      else words[words.length - 1][1] += text;            // punctuation, or a word sent in parts
      gap = false;
    }
    if (!words.length) continue;
    const parts = [`[${stamp(words[0][0])}]`, ...words.map(([when, text]) => `<${stamp(when)}> ${text}`)];
    if (end > words[words.length - 1][0]) parts.push(`<${stamp(end)}>`);
    out.push(parts.join(" "));
  }
  return out.join("\n");
}

const clean = subtitles => String(subtitles || "").split("\n").filter(l => !NOTICE.test(l)).join("\n").trim();

// The best timed lyrics the key can get, as { text, worded } or null. Throws PlanError when the key is the problem.
async function fetchLyrics(key, artist, title, duration) {
  if (!key || !title) return null;
  const params = { q_track: title };
  if (artist) params.q_artist = artist;
  if (duration) params.q_duration = Math.floor(duration);
  const found = await ask("matcher.track.get", key, params);
  const track = found?.track;
  if (!track || !matches(track.track_name, track.artist_name, +(track.track_length || 0), title, artist, duration)) return null;
  const ident = track.commontrack_id ? { commontrack_id: track.commontrack_id } : { track_id: track.track_id };
  if (track.has_richsync) {
    const rich = await ask("track.richsync.get", key, ident);
    const lrc = richsyncToLrc(rich?.richsync?.richsync_body);
    if (lrc) return { text: lrc, worded: true };
  }
  if (track.has_subtitles) {
    const sub = await ask("track.subtitle.get", key, { ...ident, subtitle_format: "lrc" });
    const lrc = clean(sub?.subtitle?.subtitle_body);
    if (lrc) return { text: lrc, worded: false };
  }
  return null;
}

module.exports = { fetchLyrics, richsyncToLrc, matches, PlanError };
