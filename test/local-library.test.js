// Local library (local-library.js): the tag and cover readers for each format, the file walk,
// and what a scanned track looks like.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LocalLibrary, parseFlac, parseId3, parseMp4, parseWav, readTrack, walk, isAudio, isMedia, mediaUrl,
  embeddedLyrics, writeFlacLyrics,
} = require("../local-library.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orchard-test-"));
const syncsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

// ---- FLAC ---------------------------------------------------------------------------------------
function flacBlock(type, payload, last = false) {
  const head = Buffer.from([(last ? 0x80 : 0) | type, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

function streamInfo({ sampleRate = 44100, channels = 2, bits = 16, samples = 88200 } = {}) {
  const b = Buffer.alloc(34);
  b.writeUInt16BE(4096, 0);
  b.writeUInt16BE(4096, 2);
  b[10] = (sampleRate >> 12) & 0xff;
  b[11] = (sampleRate >> 4) & 0xff;
  b[12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | ((bits - 1) >> 4);
  b[13] = (((bits - 1) & 0x0f) << 4) | Math.floor(samples / 2 ** 32);
  b.writeUInt32BE(samples >>> 0, 14);
  return b;
}

function vorbisComment(entries, vendor = "orchard-test") {
  const v = Buffer.from(vendor);
  const parts = [Buffer.alloc(4), v, Buffer.alloc(4)];
  parts[0].writeUInt32LE(v.length, 0);
  parts[2].writeUInt32LE(entries.length, 0);
  for (const line of entries) {
    const b = Buffer.from(line);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    parts.push(len, b);
  }
  return Buffer.concat(parts);
}

function pictureBlock(data, { mime = "image/png", type = 3 } = {}) {
  const head = Buffer.alloc(4 + 4 + mime.length + 4 + 16 + 4);
  let p = 0;
  head.writeUInt32BE(type, p); p += 4;
  head.writeUInt32BE(mime.length, p); p += 4;
  head.write(mime, p, "ascii"); p += mime.length;
  head.writeUInt32BE(0, p); p += 4;      // empty description
  p += 16;                                // width, height, depth, colours
  head.writeUInt32BE(data.length, p);
  return Buffer.concat([head, data]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makeFlac() {
  return Buffer.concat([
    Buffer.from("fLaC", "ascii"),
    flacBlock(0, streamInfo()),
    flacBlock(4, vorbisComment([
      "TITLE=Paper Lanterns", "ARTIST=June Harrow", "ALBUM=Quiet Hours",
      "ALBUMARTIST=June Harrow", "TRACKNUMBER=3/9", "DATE=2024-05-01", "GENRE=Folk",
    ])),
    flacBlock(6, pictureBlock(PNG), true),
  ]);
}

test("FLAC: STREAMINFO gives the exact length and format", () => {
  const out = parseFlac(makeFlac());
  assert.equal(out.sampleRate, 44100);
  assert.equal(out.channels, 2);
  assert.equal(out.bitsPerSample, 16);
  assert.equal(out.duration, 2);
});

test("FLAC: VORBIS_COMMENT gives the tags, first value wins", () => {
  const out = parseFlac(makeFlac());
  assert.equal(out.tags.TITLE, "Paper Lanterns");
  assert.equal(out.tags.ARTIST, "June Harrow");
  assert.equal(out.tags.ALBUM, "Quiet Hours");
  assert.equal(out.tags.ALBUMARTIST, "June Harrow");
  assert.equal(out.tags.TRACKNUMBER, "3/9");
  assert.equal(out.tags.DATE, "2024-05-01");
});

test("FLAC: PICTURE gives the cover and its type", () => {
  const out = parseFlac(makeFlac());
  assert.equal(out.cover.mime, "image/png");
  assert.deepEqual([...out.cover.data], [...PNG]);
});

test("FLAC: a stream behind an ID3v2 tag is still read", () => {
  const flac = makeFlac();
  const id3 = Buffer.concat([
    Buffer.from("ID3", "ascii"), Buffer.from([3, 0, 0]), syncsafe(0),
  ]);
  const out = parseFlac(Buffer.concat([id3, flac]));
  assert.equal(out.sampleRate, 44100);
});

test("FLAC: anything else is refused", () => {
  assert.equal(parseFlac(Buffer.from("not a flac file at all")), null);
});

// ---- ID3v2 --------------------------------------------------------------------------------------
function id3Frame(id, payload, major = 3) {
  const head = Buffer.alloc(10);
  head.write(id, 0, "ascii");
  if (major === 4) syncsafe(payload.length).copy(head, 4);
  else head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}
const textFrame = (id, text, major) => id3Frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(text, "utf8")]), major);

function makeId3(major = 3, title = "Paper Lanterns") {
  const apic = Buffer.concat([
    Buffer.from([0]), Buffer.from("image/jpeg", "latin1"), Buffer.from([0]),
    Buffer.from([3]), Buffer.from([0]), PNG,
  ]);
  const uslt = Buffer.concat([
    Buffer.from([3]), Buffer.from("eng", "latin1"), Buffer.from("desc\0", "latin1"),
    Buffer.from("Line one\nLine two", "utf8"),
  ]);
  const frames = Buffer.concat([
    textFrame("TIT2", title, major),
    textFrame("TPE1", "June Harrow", major),
    textFrame("TALB", "Quiet Hours", major),
    textFrame("TPE2", "June Harrow", major),
    textFrame("TRCK", "3/9", major),
    textFrame("TDRC", "2024", major),
    id3Frame("USLT", uslt, major),
    id3Frame("APIC", apic, major),
  ]);
  return Buffer.concat([
    Buffer.from("ID3", "ascii"), Buffer.from([major, 0, 0]), syncsafe(frames.length), frames,
  ]);
}

test("ID3v2.3: text frames become tags and APIC becomes the cover", () => {
  const file = makeId3(3);
  const out = parseId3(file);
  assert.equal(out.tags.TITLE, "Paper Lanterns");
  assert.equal(out.tags.ARTIST, "June Harrow");
  assert.equal(out.tags.ALBUM, "Quiet Hours");
  assert.equal(out.tags.ALBUMARTIST, "June Harrow");
  assert.equal(out.tags.TRACKNUMBER, "3/9");
  assert.equal(out.tags.DATE, "2024");
  assert.equal(out.tags.LYRICS, "Line one\nLine two");
  assert.equal(out.cover.mime, "image/jpeg");
  assert.deepEqual([...out.cover.data], [...PNG]);
  assert.equal(out.audioStart, file.length, "audio starts after the whole tag");
});

test("ID3v2.4: syncsafe frame sizes, including a long title", () => {
  const long = "A".repeat(300);
  const out = parseId3(makeId3(4, long));
  assert.equal(out.tags.TITLE, long);
  assert.equal(out.tags.ARTIST, "June Harrow");
});

test("ID3: a file without a tag is not an ID3 file", () => {
  assert.equal(parseId3(Buffer.from("just some audio bytes")), null);
});

// ---- MP4 / M4A ----------------------------------------------------------------------------------
const atom = (type, payload) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
};
const dataAtom = (kind, payload) => atom("data", Buffer.concat([
  Buffer.from([0, 0, 0, kind]), Buffer.from([0, 0, 0, 0]), payload,
]));
const textEntry = (name, value) => atom(name, dataAtom(1, Buffer.from(value, "utf8")));

function makeMp4() {
  const mvhd = Buffer.alloc(100);
  mvhd[0] = 0;                    // version 0
  mvhd.writeUInt32BE(1000, 12);   // timescale
  mvhd.writeUInt32BE(3500, 16);   // duration
  const trkn = atom("trkn", dataAtom(0, Buffer.from([0, 0, 0, 3, 0, 9, 0, 0])));
  const ilst = atom("ilst", Buffer.concat([
    textEntry("\u00a9nam", "Paper Lanterns"),
    textEntry("\u00a9ART", "June Harrow"),
    textEntry("\u00a9alb", "Quiet Hours"),
    textEntry("\u00a9lyr", "Line one\nLine two"),
    trkn,
    atom("covr", dataAtom(14, PNG)),
  ]));
  const meta = atom("meta", Buffer.concat([Buffer.from([0, 0, 0, 0]), ilst]));
  const udta = atom("udta", meta);
  const moov = atom("moov", Buffer.concat([atom("mvhd", mvhd), udta]));
  return atom("ftyp", Buffer.from("M4A \0\0\0\0", "latin1")).length ? Buffer.concat([atom("ftyp", Buffer.from("M4A \0\0\0\0", "latin1")), moov]) : moov;
}

test("MP4: mvhd gives the length, ilst gives tags, covr gives the cover", () => {
  const out = parseMp4(makeMp4());
  assert.equal(out.duration, 3.5);
  assert.equal(out.tags.TITLE, "Paper Lanterns");
  assert.equal(out.tags.ARTIST, "June Harrow");
  assert.equal(out.tags.ALBUM, "Quiet Hours");
  assert.equal(out.tags.TRACKNUMBER, "3");
  assert.equal(out.tags.LYRICS, "Line one\nLine two");
  assert.equal(out.cover.mime, "image/png");
  assert.deepEqual([...out.cover.data], [...PNG]);
});

test("MP4: a file with no moov atom is refused", () => {
  assert.equal(parseMp4(Buffer.from("nothing here")), null);
});

// ---- WAV ----------------------------------------------------------------------------------------
function wavChunk(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function makeWav({ tagged = true } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(44100, 4);
  fmt.writeUInt32LE(176400, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);
  const info = Buffer.concat([
    Buffer.from("INFO", "ascii"),
    wavChunk("INAM", Buffer.from("Paper Lanterns\0", "utf8")),
    wavChunk("IART", Buffer.from("June Harrow\0", "utf8")),
  ]);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE", "ascii"),
    wavChunk("fmt ", fmt),
    ...(tagged ? [wavChunk("LIST", info)] : []),
    wavChunk("data", Buffer.alloc(352800)),
  ]);
}

test("WAV: fmt and data give the length, LIST INFO gives the tags", () => {
  const out = parseWav(makeWav());
  assert.equal(out.duration, 2);
  assert.equal(out.tags.TITLE, "Paper Lanterns");
  assert.equal(out.tags.ARTIST, "June Harrow");
});

test("WAV: a file that isn't RIFF/WAVE is refused", () => {
  assert.equal(parseWav(Buffer.from("RIFF0000AVI ")), null);
});

// ---- files --------------------------------------------------------------------------------------
test("isAudio and isMedia know the formats Orchard reads", () => {
  for (const f of ["a.flac", "a.MP3", "a.m4a", "a.ogg", "a.opus", "a.wav", "a.aiff"]) assert.equal(isAudio(f), true, f);
  assert.equal(isAudio("cover.jpg"), false);
  assert.equal(isMedia("cover.JPG"), true);
  assert.equal(isMedia("notes.txt"), false);
});

test("mediaUrl percent-encodes the path", () => {
  assert.equal(mediaUrl("/tmp/a b/c.flac"), "/media?path=%2Ftmp%2Fa%20b%2Fc.flac");
});

test("walk finds audio, skips hidden folders and node_modules", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "album"));
  fs.mkdirSync(path.join(root, ".cache"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "album", "one.flac"), "x");
  fs.writeFileSync(path.join(root, "album", "two.mp3"), "x");
  fs.writeFileSync(path.join(root, "album", "cover.jpg"), "x");
  fs.writeFileSync(path.join(root, ".cache", "hidden.flac"), "x");
  fs.writeFileSync(path.join(root, "node_modules", "dep.flac"), "x");
  fs.writeFileSync(path.join(root, "root.wav"), "x");

  const found = [];
  walk(root, found);
  assert.deepEqual(found.map(f => path.basename(f)).sort(), ["one.flac", "root.wav", "two.mp3"]);
});

test("walk takes a single file too", () => {
  const dir = tmp();
  const file = path.join(dir, "one.flac");
  fs.writeFileSync(file, "x");
  const found = [];
  walk(file, found);
  assert.deepEqual(found, [file]);
});

// ---- readTrack and the library ------------------------------------------------------------------
test("readTrack reads tags, length, format and writes the cover out", () => {
  const dir = tmp();
  const file = path.join(dir, "03 - Paper Lanterns.flac");
  fs.writeFileSync(file, makeFlac());
  const covers = path.join(dir, "covers");

  const track = readTrack(file, covers);
  assert.equal(track.kind, "song");
  assert.equal(track.local, true);
  assert.equal(track.title, "Paper Lanterns");
  assert.equal(track.artist, "June Harrow");
  assert.equal(track.album, "Quiet Hours");
  assert.equal(track.ms, 2000);
  assert.equal(track.format, "FLAC");
  assert.equal(track.sampleRate, 44100);
  assert.equal(track.bitsPerSample, 16);
  assert.equal(track.channels, 2);
  assert.equal(track.track, 3);
  assert.equal(track.trackTotal, 9);
  assert.equal(track.year, "2024");
  assert.match(track.src, /^\/media\?path=/);
  assert.ok(track.art.startsWith("/media?path="));
  assert.ok(fs.existsSync(path.join(covers, path.basename(decodeURIComponent(track.art.split("path=")[1])))));
});

test("readTrack falls back to the file name when there are no tags", () => {
  const dir = tmp();
  const file = path.join(dir, "07 - June Harrow - Salt Air.wav");
  fs.writeFileSync(file, makeWav({ tagged: false }));
  const track = readTrack(file, path.join(dir, "covers"));
  assert.equal(track.title, "Salt Air");
  assert.equal(track.artist, "June Harrow");
  assert.equal(track.album, path.basename(dir));
  assert.equal(track.format, "WAV");
});

test("a scanned library groups albums and artists", async () => {
  const dir = tmp();
  const music = path.join(dir, "music");
  fs.mkdirSync(music);
  fs.writeFileSync(path.join(music, "01.flac"), makeFlac());
  fs.writeFileSync(path.join(music, "02.flac"), makeFlac());
  fs.writeFileSync(path.join(music, "03.flac"), makeFlac());

  const lib = new LocalLibrary(path.join(dir, "library"));
  const state = await lib.addPaths([music]);
  assert.equal(state.tracks.length, 3);
  assert.equal(state.albums.length, 1);
  assert.equal(state.albums[0].title, "Quiet Hours");
  assert.equal(state.albums[0].count, 3);
  assert.equal(state.artists.length, 1);
  assert.equal(state.artists[0].title, "June Harrow");

  const again = lib.get();
  assert.equal(again.tracks.length, 3);
  assert.deepEqual(again.roots.map(r => r.kind), ["folder"]);
  // The renderer filters local.tracks itself, so albums and artists travel without their track lists.
  assert.equal(again.albums[0].tracks, undefined);
  assert.equal(again.artists[0].tracks, undefined);
  assert.equal(again.artists[0].count, 3);

  lib.removeTrack(state.tracks[0].path);
  assert.equal(lib.get().tracks.length, 2);

  lib.clear();
  assert.equal(lib.get().tracks.length, 0);
  assert.equal(lib.get().roots.length, 0);
});

// ---- lyrics in the file and beside it ------------------------------------------------------------
test("embeddedLyrics reads FLAC VORBIS_COMMENT LYRICS", () => {
  const dir = tmp();
  const file = path.join(dir, "song.flac");
  fs.writeFileSync(file, makeFlac());
  assert.equal(embeddedLyrics(file), "");
  assert.equal(writeFlacLyrics(file, "Line one\nLine two"), true);
  assert.equal(embeddedLyrics(file), "Line one\nLine two");
  assert.equal(parseFlac(fs.readFileSync(file)).tags.LYRICS, "Line one\nLine two");
});

test("writeFlacLyrics keeps the audio frames and every other tag", () => {
  const dir = tmp();
  const file = path.join(dir, "song.flac");
  const audio = Buffer.from("AUDIOFRAMES-1234", "ascii");
  fs.writeFileSync(file, Buffer.concat([makeFlac(), audio]));
  assert.equal(writeFlacLyrics(file, "Timed words"), true);
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(buf.length - audio.length).toString("ascii"), audio.toString("ascii"));
  const out = parseFlac(buf);
  assert.equal(out.tags.TITLE, "Paper Lanterns");
  assert.equal(out.tags.LYRICS, "Timed words");
  assert.equal(out.cover.mime, "image/png");
  assert.equal(out.duration, 2);
});

test("lyricsFor prefers a sidecar and falls back to embedded lyrics", () => {
  const dir = tmp();
  const file = path.join(dir, "song.flac");
  fs.writeFileSync(file, makeFlac());
  writeFlacLyrics(file, "Embedded line");
  const lib = new LocalLibrary(path.join(dir, "library"));
  assert.equal(lib.lyricsFor(file), "Embedded line");
  fs.writeFileSync(path.join(dir, "song.lrc"), "[00:01.00]Sidecar line");
  assert.equal(lib.lyricsFor(file), "[00:01.00]Sidecar line");
});

test("the lyrics cache survives a reload", () => {
  const dir = tmp();
  const lib = new LocalLibrary(path.join(dir, "library"));
  lib.setLyricsInfo("/music/a.flac", { mtimeMs: 1, done: true, synced: true });
  const again = new LocalLibrary(path.join(dir, "library"));
  assert.deepEqual(again.lyricsInfo("/music/a.flac"), { mtimeMs: 1, done: true, synced: true });
});
