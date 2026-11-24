// Local music library: recursive scanning, tags, cover art and playback metadata.
// Pure Node (no Electron) so it can be tested with `node --test`.
//
// FLAC is the first-class format: STREAMINFO for the exact length, VORBIS_COMMENT for tags and
// PICTURE for the cover. MP3 (ID3v2), M4A (MP4 atoms) and WAV are read too; anything else still
// plays through Chromium and falls back to its file name.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUDIO_EXT = new Set([".flac", ".mp3", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus", ".wav", ".aiff", ".aif"]);
const MEDIA_EXT = new Set([...AUDIO_EXT, ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const SKIP_DIRS = new Set(["node_modules", "@eaDir", ".git", ".svn", "System Volume Information", "$RECYCLE.BIN"]);
const MAX_DEPTH = 24;

const isAudio = file => AUDIO_EXT.has(path.extname(file).toLowerCase());
const isMedia = file => MEDIA_EXT.has(path.extname(file).toLowerCase());
const hash = text => crypto.createHash("sha1").update(String(text)).digest("hex");

// ---- FLAC ---------------------------------------------------------------------------------------
// Returns { tags, sampleRate, channels, bitsPerSample, duration, cover } or null.
function parseFlac(buf) {
  let off = 0;
  // Some rippers leave an ID3v2 tag in front of the FLAC stream.
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  if (buf.toString("ascii", off, off + 4) !== "fLaC") return null;
  off += 4;

  const out = { tags: {}, sampleRate: 0, channels: 0, bitsPerSample: 0, duration: 0, cover: null };
  let totalSamples = 0;

  while (off + 4 <= buf.length) {
    const header = buf[off], last = header & 0x80, type = header & 0x7f;
    const length = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const start = off + 4, end = start + length;
    if (end > buf.length) break;
    const block = buf.subarray(start, end);

    if (type === 0 && length >= 34) {
      const b = block;
      out.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      out.channels = ((b[12] >> 1) & 0x07) + 1;
      out.bitsPerSample = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
      totalSamples = (b[13] & 0x0f) * 2 ** 32 + b[14] * 2 ** 24 + b[15] * 2 ** 16 + b[16] * 2 ** 8 + b[17];
    } else if (type === 4) {
      let p = 0;
      if (p + 4 > block.length) { off = end; if (last) break; continue; }
      const vendor = block.readUInt32LE(p); p += 4 + vendor;
      if (p + 4 <= block.length) {
        const count = block.readUInt32LE(p); p += 4;
        for (let i = 0; i < count && p + 4 <= block.length; i++) {
          const n = block.readUInt32LE(p); p += 4;
          if (p + n > block.length) break;
          const line = block.toString("utf8", p, p + n); p += n;
          const eq = line.indexOf("=");
          if (eq > 0) {
            const key = line.slice(0, eq).toUpperCase(), value = line.slice(eq + 1);
            if (!(key in out.tags)) out.tags[key] = value;
          }
        }
      }
    } else if (type === 6 && length > 32) {
      let p = 0;
      const pictureType = block.readUInt32BE(p); p += 4;
      const mimeLen = block.readUInt32BE(p); p += 4;
      const mime = block.toString("ascii", p, p + mimeLen); p += mimeLen;
      const descLen = block.readUInt32BE(p); p += 4 + descLen;
      p += 16; // width, height, depth, colours
      if (p + 4 <= block.length) {
        const dataLen = block.readUInt32BE(p); p += 4;
        if (p + dataLen <= block.length) {
          const data = block.subarray(p, p + dataLen);
          if (!out.cover || pictureType === 3) out.cover = { mime: mime || "image/jpeg", data };
        }
      }
    }
    off = end;
    if (last) break;
  }
  out.duration = out.sampleRate ? totalSamples / out.sampleRate : 0;
  return out;
}

// ---- ID3v2 (MP3) ---------------------------------------------------------------------------------
const ID3_FRAMES = { TIT2: "TITLE", TPE1: "ARTIST", TALB: "ALBUM", TPE2: "ALBUMARTIST", TRCK: "TRACKNUMBER",
  TPOS: "DISCNUMBER", TDRC: "DATE", TYER: "DATE", TCON: "GENRE", TCOM: "COMPOSER" };

function id3Text(data, encoding) {
  try {
    if (encoding === 1) return data.toString("utf16le").replace(/\0+$/, "").replace(/^\uFEFF/, "");
    if (encoding === 2) return data.toString("utf16be").replace(/\0+$/, "");
    if (encoding === 3) return data.toString("utf8").replace(/\0+$/, "");
    return data.toString("latin1").replace(/\0+$/, "");
  } catch { return ""; }
}

function parseId3(buf) {
  if (buf.length < 10 || buf.toString("ascii", 0, 3) !== "ID3") return null;
  const major = buf[3], flags = buf[5];
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  let p = 10;
  if (flags & 0x40) { // extended header
    const ext = major === 4 ? ((buf[p] & 0x7f) << 21) | ((buf[p + 1] & 0x7f) << 14) | ((buf[p + 2] & 0x7f) << 7) | (buf[p + 3] & 0x7f) : buf.readUInt32BE(p);
    p += ext;
  }
  const end = Math.min(buf.length, 10 + size);
  const out = { tags: {}, cover: null, audioStart: end };
  while (p + 10 <= end) {
    const id = buf.toString("ascii", p, p + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = major === 4
      ? ((buf[p + 4] & 0x7f) << 21) | ((buf[p + 5] & 0x7f) << 14) | ((buf[p + 6] & 0x7f) << 7) | (buf[p + 7] & 0x7f)
      : buf.readUInt32BE(p + 4);
    if (!frameSize) break;
    const start = p + 10, stop = start + frameSize;
    if (stop > end) break;
    const frame = buf.subarray(start, stop);
    if (id === "APIC" && frame.length > 4) {
      const enc = frame[0];
      let q = 1;
      const mimeEnd = frame.indexOf(0, q);
      const mime = mimeEnd > q ? frame.toString("latin1", q, mimeEnd) : "image/jpeg";
      q = mimeEnd + 1;
      const type = frame[q]; q += 1;
      // description is terminated by one or two null bytes depending on the encoding
      if (enc === 1 || enc === 2) { while (q + 1 < frame.length && !(frame[q] === 0 && frame[q + 1] === 0)) q += 2; q += 2; }
      else { while (q < frame.length && frame[q] !== 0) q++; q += 1; }
      if (q < frame.length && (!out.cover || type === 3)) out.cover = { mime: mime || "image/jpeg", data: frame.subarray(q) };
    } else if (id === "USLT" && frame.length > 4) {
      // encoding (1) + language (3) + descriptor (null-terminated) + the words
      const enc = frame[0];
      let q = 4;
      if (enc === 1 || enc === 2) { while (q + 1 < frame.length && !(frame[q] === 0 && frame[q + 1] === 0)) q += 2; q += 2; }
      else { while (q < frame.length && frame[q] !== 0) q++; q += 1; }
      const value = id3Text(frame.subarray(q), enc);
      if (value && !out.tags.LYRICS) out.tags.LYRICS = value;
    } else if (ID3_FRAMES[id] && frame.length > 1) {
      const key = ID3_FRAMES[id];
      const value = id3Text(frame.subarray(1), frame[0]);
      if (value && !(key in out.tags)) out.tags[key] = value;
    }
    p = stop;
  }
  return out;
}

// A rough MPEG audio length, used when there is no Xing/Info header. Exact enough for a list.
function mp3Duration(buf, start) {
  const rates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  for (let p = start; p + 4 < Math.min(buf.length, start + 8192); p++) {
    if (buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[p + 1] >> 3) & 3, layer = (buf[p + 1] >> 1) & 3;
    if (ver === 1 || layer === 0) continue;
    const table = layer === 3 ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
      : layer === 2 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
      : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const bitrate = table[(buf[p + 2] >> 4) & 15] * 1000;
    const sampleRate = rates[ver]?.[(buf[p + 2] >> 2) & 3];
    if (!bitrate || !sampleRate) continue;
    return Math.max(0, (buf.length - start) * 8 / bitrate);
  }
  return 0;
}

// ---- MP4 / M4A -----------------------------------------------------------------------------------
function atomChildren(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    // latin1, not ascii: iTunes atom names start with 0xA9 (©nam, ©ART, …) and ascii would drop the high bit.
    const type = buf.toString("latin1", p + 4, p + 8);
    let head = 8;
    if (size === 1) { if (p + 16 > end) break; size = Number(buf.readBigUInt64BE(p + 8)); head = 16; }
    if (size < head || p + size > end) break;
    out.push({ type, start: p + head, end: p + size, raw: p });
    p += size;
  }
  return out;
}

function parseMp4(buf) {
  const root = atomChildren(buf, 0, buf.length);
  const out = { tags: {}, cover: null, duration: 0 };
  const find = (nodes, type) => nodes.find(n => n.type === type);
  const moov = find(root, "moov");
  if (!moov) return null;
  const moovKids = atomChildren(buf, moov.start, moov.end);
  const mvhd = find(moovKids, "mvhd");
  if (mvhd) {
    const v = buf[mvhd.start];
    if (v === 1 && mvhd.start + 32 <= mvhd.end) {
      const scale = buf.readUInt32BE(mvhd.start + 20), dur = Number(buf.readBigUInt64BE(mvhd.start + 24));
      out.duration = scale ? dur / scale : 0;
    } else if (mvhd.start + 20 <= mvhd.end) {
      const scale = buf.readUInt32BE(mvhd.start + 12), dur = buf.readUInt32BE(mvhd.start + 16);
      out.duration = scale ? dur / scale : 0;
    }
  }
  const udta = find(moovKids, "udta");
  if (udta) {
    const meta = find(atomChildren(buf, udta.start, udta.end), "meta");
    if (meta) {
      const metaKids = atomChildren(buf, meta.start + 4, meta.end);
      const ilst = find(metaKids, "ilst");
      if (ilst) {
        const names = { "\u00a9nam": "TITLE", "\u00a9ART": "ARTIST", "\u00a9alb": "ALBUM", "aART": "ALBUMARTIST",
          "trkn": "TRACKNUMBER", "disk": "DISCNUMBER", "\u00a9day": "DATE", "\u00a9gen": "GENRE", "\u00a9wrt": "COMPOSER",
          "\u00a9cmt": "COMMENT", "\u00a9lyr": "LYRICS" };
        for (const entry of atomChildren(buf, ilst.start, ilst.end)) {
          const data = find(atomChildren(buf, entry.start, entry.end), "data");
          if (!data) continue;
          const kind = buf.readUInt32BE(data.start) & 0xffffff;
          const payload = buf.subarray(data.start + 8, data.end);
          if (entry.type === "covr") {
            const mime = kind === 14 ? "image/png" : "image/jpeg";
            if (!out.cover) out.cover = { mime, data: payload };
          } else if (names[entry.type]) {
            let value;
            if (entry.type === "trkn" || entry.type === "disk") value = payload.length >= 4 ? String(payload.readUInt16BE(2)) : "";
            else value = payload.toString("utf8").replace(/\0+$/, "");
            if (value) out.tags[names[entry.type]] = value;
          }
        }
      }
    }
  }
  return out;
}

// ---- WAV -----------------------------------------------------------------------------------------
function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  const out = { tags: {}, cover: null, duration: 0 };
  let p = 12, byteRate = 0;
  while (p + 8 <= buf.length) {
    const type = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const start = p + 8, end = Math.min(buf.length, start + size);
    if (type === "fmt " && size >= 12) byteRate = buf.readUInt32LE(start + 8);
    else if (type === "data" && byteRate) out.duration = (end - start) / byteRate;
    else if (type === "LIST" && buf.toString("ascii", start, start + 4) === "INFO") {
      let q = start + 4;
      while (q + 8 <= end) {
        const id = buf.toString("ascii", q, q + 4), n = buf.readUInt32LE(q + 4);
        const v = buf.toString("utf8", q + 8, Math.min(end, q + 8 + n)).replace(/\0+$/, "");
        const key = { INAM: "TITLE", IART: "ARTIST", IPRD: "ALBUM", ICMT: "COMMENT", ICRD: "DATE", IGNR: "GENRE" }[id];
        if (key && v) out.tags[key] = v;
        q += 8 + n + (n & 1);
      }
    }
    p = start + size + (size & 1);
  }
  return out;
}

// ---- files ---------------------------------------------------------------------------------------
function splitNumber(value) {
  const m = String(value || "").match(/^\s*(\d+)(?:\s*\/\s*(\d+))?/);
  return m ? { number: +m[1], total: m[2] ? +m[2] : 0 } : { number: 0, total: 0 };
}

function fromName(file) {
  const base = path.basename(file, path.extname(file)).replace(/_/g, " ").trim();
  const cleaned = base.replace(/^\s*\d{1,3}[\s._-]+/, "");
  const m = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "", title: cleaned };
}

function normalizeTags(tags, file) {
  const fallback = fromName(file);
  const get = (...keys) => {
    for (const k of keys) if (tags[k] && String(tags[k]).trim()) return String(tags[k]).trim();
    return "";
  };
  const title = get("TITLE") || fallback.title;
  const artist = get("ARTIST") || fallback.artist || "Unknown Artist";
  const albumArtist = get("ALBUMARTIST", "ALBUM ARTIST") || artist;
  const album = get("ALBUM") || path.basename(path.dirname(file)) || "Unknown Album";
  const track = splitNumber(get("TRACKNUMBER", "TRACK"));
  const disc = splitNumber(get("DISCNUMBER", "DISC"));
  return {
    title, artist, albumArtist, album,
    genre: get("GENRE"),
    year: (get("DATE", "YEAR").match(/\d{4}/) || [""])[0],
    composer: get("COMPOSER"),
    track: track.number, trackTotal: track.total,
    disc: disc.number || 1, discTotal: disc.total,
    hasLyrics: !!get("LYRICS", "UNSYNCEDLYRICS", "LYRIC"),
  };
}

function readHead(file, max = 8 * 1024 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, max);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return buf;
  } finally { fs.closeSync(fd); }
}

function saveCover(coverDir, id, cover) {
  if (!cover?.data?.length) return "";
  const ext = /png/i.test(cover.mime) ? ".png" : /webp/i.test(cover.mime) ? ".webp" : ".jpg";
  const file = path.join(coverDir, id + ext);
  try {
    fs.mkdirSync(coverDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, cover.data);
    return file;
  } catch { return ""; }
}

function readTrack(file, coverDir, cached) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.track) return cached.track;

  const ext = path.extname(file).toLowerCase();
  let parsed = null;
  try {
    // FLAC, ID3 and RIFF keep their metadata at the front, so a head read is enough even for
    // very large files. MP4 can put its moov atom at the end, so those are read whole.
    const buf = ext === ".m4a" || ext === ".mp4" || ext === ".aac" ? fs.readFileSync(file) : readHead(file);
    if (ext === ".flac") parsed = parseFlac(buf);
    else if (ext === ".mp3") {
      const id3 = parseId3(buf);
      if (id3) parsed = { tags: id3.tags, cover: id3.cover, duration: mp3Duration(buf, id3.audioStart) };
      else parsed = { tags: {}, cover: null, duration: mp3Duration(buf, 0) };
    } else if (ext === ".m4a" || ext === ".mp4" || ext === ".aac") parsed = parseMp4(buf);
    else if (ext === ".wav") parsed = parseWav(buf);
  } catch { parsed = null; }

  const id = hash(file).slice(0, 20);
  const tags = normalizeTags(parsed?.tags || {}, file);
  const coverFile = saveCover(coverDir, id, parsed?.cover);
  const albumKey = hash((tags.albumArtist + "\u0000" + tags.album).toLowerCase()).slice(0, 16);
  const track = {
    kind: "song", local: true, id: "local:" + id, path: file, src: mediaUrl(file),
    ...tags, ms: Math.round((parsed?.duration || 0) * 1000),
    sampleRate: parsed?.sampleRate || 0, bitsPerSample: parsed?.bitsPerSample || 0, channels: parsed?.channels || 0,
    format: ext.slice(1).toUpperCase(), albumKey,
    art: coverFile ? mediaUrl(coverFile) : "",
    mtimeMs: stat.mtimeMs, size: stat.size,
  };
  return track;
}

function mediaUrl(file) { return "/media?path=" + encodeURIComponent(file); }

// ---- lyrics in the file and beside it ---------------------------------------------------------
// Tags first-class for FLAC (VORBIS_COMMENT LYRICS), plus ID3v2 USLT and MP4 ©lyr on the way in.
function embeddedLyrics(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    const buf = ext === ".m4a" || ext === ".mp4" || ext === ".aac" ? fs.readFileSync(file) : readHead(file);
    let parsed = null;
    if (ext === ".flac") parsed = parseFlac(buf);
    else if (ext === ".mp3") parsed = parseId3(buf);
    else if (ext === ".m4a" || ext === ".mp4" || ext === ".aac") parsed = parseMp4(buf);
    else if (ext === ".wav") parsed = parseWav(buf);
    return parsed?.tags?.LYRICS || parsed?.tags?.UNSYNCEDLYRICS || "";
  } catch { return ""; }
}

function readVorbisComments(data) {
  let p = 0;
  if (p + 4 > data.length) throw new Error("short comment block");
  const vendorLen = data.readUInt32LE(p); p += 4;
  if (p + vendorLen > data.length) throw new Error("short vendor");
  const vendor = data.toString("utf8", p, p + vendorLen); p += vendorLen;
  if (p + 4 > data.length) throw new Error("short count");
  const count = data.readUInt32LE(p); p += 4;
  const comments = [];
  for (let i = 0; i < count && p + 4 <= data.length; i++) {
    const n = data.readUInt32LE(p); p += 4;
    if (p + n > data.length) break;
    comments.push(data.toString("utf8", p, p + n));
    p += n;
  }
  return { vendor, comments };
}

function writeVorbisComments(vendor, comments) {
  const v = Buffer.from(vendor || "Orchard", "utf8");
  const parts = [Buffer.alloc(4), v, Buffer.alloc(4)];
  parts[0].writeUInt32LE(v.length, 0);
  parts[2].writeUInt32LE(comments.length, 0);
  for (const comment of comments) {
    const b = Buffer.from(comment, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    parts.push(len, b);
  }
  return Buffer.concat(parts);
}

// Rewrite the FLAC metadata blocks with LYRICS set, leaving the audio frames byte-for-byte alone.
function writeFlacLyrics(file, text) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  let off = 0;
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  if (buf.toString("ascii", off, off + 4) !== "fLaC") return false;

  const prefix = buf.subarray(0, off);
  let p = off + 4;
  const blocks = [];
  let last = false;
  while (!last) {
    if (p + 4 > buf.length) return false;
    const header = buf[p], type = header & 0x7f;
    last = !!(header & 0x80);
    const length = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const start = p + 4, end = start + length;
    if (end > buf.length) return false;
    blocks.push({ type, data: buf.subarray(start, end) });
    p = end;
  }
  const audio = buf.subarray(p);

  let vc = blocks.find(b => b.type === 4);
  let vendor = "Orchard", comments = [];
  if (vc) {
    try {
      const decoded = readVorbisComments(vc.data);
      vendor = decoded.vendor || vendor;
      comments = decoded.comments;
    } catch {}
  }
  comments = comments.filter(c => !/^(LYRICS|UNSYNCEDLYRICS)=/i.test(c));
  comments.push("LYRICS=" + String(text).replace(/\r\n/g, "\n"));
  const data = writeVorbisComments(vendor, comments);
  if (vc) vc.data = data;
  else blocks.splice(Math.min(1, blocks.length), 0, { type: 4, data });

  const parts = [prefix, Buffer.from("fLaC", "ascii")];
  blocks.forEach((b, i) => {
    const head = Buffer.alloc(4);
    head[0] = (i === blocks.length - 1 ? 0x80 : 0) | b.type;
    head.writeUIntBE(b.data.length, 1, 3);
    parts.push(head, b.data);
  });
  parts.push(audio);

  const tmp = file + ".orchard-tmp";
  try {
    fs.writeFileSync(tmp, Buffer.concat(parts));
    fs.chmodSync(tmp, fs.statSync(file).mode);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

function walk(target, out, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let stat;
  try { stat = fs.statSync(target); } catch { return; }
  if (stat.isFile()) { if (isAudio(target)) out.push(target); return; }
  if (!stat.isDirectory()) return;
  let entries;
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(child, out, depth + 1);
    else if (entry.isFile() && isAudio(child)) out.push(child);
  }
}

const sortTracks = tracks => tracks.sort((a, b) =>
  (a.albumArtist || "").localeCompare(b.albumArtist || "", undefined, { sensitivity: "base" }) ||
  (a.album || "").localeCompare(b.album || "", undefined, { sensitivity: "base" }) ||
  (a.disc || 1) - (b.disc || 1) || (a.track || 0) - (b.track || 0) ||
  (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));

class LocalLibrary {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "local-library.json");
    this.cacheFile = path.join(dir, "local-cache.json");
    this.lyricsFile = path.join(dir, "local-lyrics.json");
    this.coverDir = path.join(dir, "covers");
    this.state = { roots: [], tracks: [], excluded: [] };
    this.cache = {};
    this.lyrics = {};
    this.load();
  }

  load() {
    try { this.state = { roots: [], tracks: [], excluded: [], ...JSON.parse(fs.readFileSync(this.file, "utf8")) }; } catch {}
    try { this.cache = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")); } catch { this.cache = {}; }
    try { this.lyrics = JSON.parse(fs.readFileSync(this.lyricsFile, "utf8")); } catch { this.lyrics = {}; }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state));
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
      fs.writeFileSync(this.lyricsFile, JSON.stringify(this.lyrics));
    } catch (e) { console.warn("[Orchard] Could not save local library:", e.message); }
  }

  // The lyrics job touches the library once per track; writing every time meant two full-library files per
  // song. This coalesces those into one write a second.
  saveLater() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 1000);
    this._saveTimer.unref?.();
  }

  // The same writes, off the event loop: a big library is tens of megabytes and a sync write would stall
  // the window at the end of every scan.
  async saveAsync() {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(this.file, JSON.stringify(this.state));
      await fs.promises.writeFile(this.cacheFile, JSON.stringify(this.cache));
      await fs.promises.writeFile(this.lyricsFile, JSON.stringify(this.lyrics));
    } catch (e) { console.warn("[Orchard] Could not save local library:", e.message); }
  }

  // `lean` leaves each album's and artist's `tracks` out: the renderer already has every track and filters
  // by albumKey or name, and sending the same objects three times made the IPC payload enormous.
  get(lean = true) {
    return { roots: this.state.roots, tracks: this.state.tracks, excluded: this.state.excluded,
             albums: this.albums(lean), artists: this.artists(lean) };
  }

  albums(lean = false) {
    const map = new Map();
    for (const t of this.state.tracks) {
      let a = map.get(t.albumKey);
      if (!a) map.set(t.albumKey, a = { kind: "album", local: true, id: "local-album:" + t.albumKey, albumKey: t.albumKey,
        title: t.album, artist: t.albumArtist || t.artist, art: t.art, year: t.year, tracks: [] });
      a.tracks.push(t);
      if (!a.art && t.art) a.art = t.art;
    }
    for (const a of map.values()) {
      a.ms = a.tracks.reduce((n, t) => n + (t.ms || 0), 0);
      a.count = a.tracks.length;
    }
    const list = [...map.values()].sort((a, b) => (a.artist || "").localeCompare(b.artist || "", undefined, { sensitivity: "base" }) || a.title.localeCompare(b.title));
    return lean ? list.map(({ tracks, ...rest }) => rest) : list;
  }

  artists(lean = false) {
    const map = new Map();
    for (const t of this.state.tracks) {
      const name = t.albumArtist || t.artist || "Unknown Artist";
      let a = map.get(name);
      if (!a) map.set(name, a = { kind: "artist", local: true, id: "local-artist:" + hash(name).slice(0, 16), title: name, artist: "Artist", art: t.art, tracks: [] });
      a.tracks.push(t);
      if (!a.art && t.art) a.art = t.art;
    }
    const list = [...map.values()].map(a => ({ ...a, count: a.tracks.length }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    return lean ? list.map(({ tracks, ...rest }) => rest) : list;
  }

  async scan(roots, onProgress) {
    const excluded = new Set(this.state.excluded || []);
    const files = [];
    for (const root of roots) {
      const found = [];
      await walk(root.path, found);
      for (const f of found) if (!excluded.has(f)) files.push(f);
    }
    const unique = [...new Set(files.map(f => path.resolve(f)))];
    const tracks = [];
    let done = 0;
    for (const file of unique) {
      let stat;
      try { stat = fs.statSync(file); } catch { done++; continue; }
      const cached = this.cache[file];
      const track = readTrack(file, this.coverDir, cached);
      if (track) {
        tracks.push(track);
        this.cache[file] = { mtimeMs: stat.mtimeMs, size: stat.size, track };
      }
      done++;
      if (onProgress && (done % 10 === 0 || done === unique.length)) onProgress({ done, total: unique.length, file });
      if (done % 20 === 0) await yieldToLoop();     // keep the window answering while a big folder is read
    }
    sortTracks(tracks);
    this.state.tracks = tracks;
    // drop cache entries for files that are gone
    const alive = new Set(unique);
    for (const key of Object.keys(this.cache)) if (!alive.has(key)) delete this.cache[key];
    await this.saveAsync();
    return this.get();
  }

  async addPaths(paths, onProgress) {
    for (const p of paths) {
      const abs = path.resolve(p);
      if (this.state.roots.some(r => r.path === abs)) continue;
      this.state.roots.push({ path: abs, kind: fs.statSync(abs).isDirectory() ? "folder" : "file" });
    }
    return this.scan(this.state.roots, onProgress);
  }

  async rescan(onProgress) { return this.scan(this.state.roots, onProgress); }

  removeRoot(rootPath) {
    const abs = path.resolve(rootPath);
    this.state.roots = this.state.roots.filter(r => r.path !== abs);
    this.state.tracks = this.state.tracks.filter(t => !(t.path === abs || t.path.startsWith(abs + path.sep)));
    this.save();
    return this.get();
  }

  removeTrack(file) {
    const abs = path.resolve(file);
    this.state.tracks = this.state.tracks.filter(t => t.path !== abs);
    if (!this.state.excluded.includes(abs)) this.state.excluded.push(abs);
    this.save();
    return this.get();
  }

  clear() {
    this.state = { roots: [], tracks: [], excluded: [] };
    this.cache = {};
    this.lyrics = {};
    this.save();
    return this.get();
  }

  lyricsFor(file) {
    const dir = path.dirname(file), base = path.basename(file, path.extname(file));
    for (const name of [base + ".lrc", base + ".LRC", base + ".Lrc"]) {
      const p = path.join(dir, name);
      try { if (fs.statSync(p).isFile()) return fs.readFileSync(p, "utf8"); } catch {}
    }
    return embeddedLyrics(file);
  }

  // What the lyrics job knows about a file: whether it was tried and whether the result was timed.
  lyricsInfo(file) { return this.lyrics[path.resolve(file)] || null; }
  // `save` false is for the bulk lyrics job, which coalesces its writes through saveLater() instead.
  setLyricsInfo(file, info, save = true) {
    this.lyrics[path.resolve(file)] = info;
    if (save) this.save(); else this.saveLater();
  }
}

module.exports = { LocalLibrary, parseFlac, parseId3, parseMp4, parseWav, readTrack, walk, isAudio, isMedia, mediaUrl, embeddedLyrics, writeFlacLyrics, AUDIO_EXT, MEDIA_EXT };
