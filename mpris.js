// Orchard's own MPRIS player, so desktop media controls and scrobblers (Pano Scrobbler, rescrobbled, …)
// see "Orchard" under a stable bus name with the song's real length, instead of Chromium's built-in one,
// which is named after the process ID (new every launch) and reports every song as an endless stream.
//
// The renderer sends the state over IPC; commands from the desktop go back to it as actions.
// Spec: https://specifications.freedesktop.org/mpris-spec/latest/
const dbus = require("dbus-next");
const { Interface, ACCESS_READ, ACCESS_READWRITE } = dbus.interface;
const { Variant } = dbus;

const BUS_NAME = "org.mpris.MediaPlayer2.orchard";
const PATH = "/org/mpris/MediaPlayer2";
const NO_TRACK = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
const us = seconds => BigInt(Math.max(0, Math.round((seconds || 0) * 1e6)));

class Root extends Interface {
  constructor(hooks) { super("org.mpris.MediaPlayer2"); this.hooks = hooks; }
  get CanQuit() { return true; }
  get CanRaise() { return true; }
  get HasTrackList() { return false; }
  get Identity() { return "Orchard"; }
  get DesktopEntry() { return "orchard"; }
  get SupportedUriSchemes() { return []; }
  get SupportedMimeTypes() { return []; }
  Raise() { this.hooks.raise(); }
  Quit() { this.hooks.quit(); }
}
Root.configureMembers({
  properties: {
    CanQuit: { signature: "b", access: ACCESS_READ },
    CanRaise: { signature: "b", access: ACCESS_READ },
    HasTrackList: { signature: "b", access: ACCESS_READ },
    Identity: { signature: "s", access: ACCESS_READ },
    DesktopEntry: { signature: "s", access: ACCESS_READ },
    SupportedUriSchemes: { signature: "as", access: ACCESS_READ },
    SupportedMimeTypes: { signature: "as", access: ACCESS_READ },
  },
  methods: { Raise: {}, Quit: {} },
});

class Player extends Interface {
  constructor(send) {
    super("org.mpris.MediaPlayer2.Player");
    this.send = send;
    this.state = { status: "Stopped", track: null, position: 0, at: Date.now(), volume: 1 };
  }
  get PlaybackStatus() { return this.state.status; }
  get Rate() { return 1; }
  set Rate(_) {}
  get MinimumRate() { return 1; }
  get MaximumRate() { return 1; }
  get Volume() { return this.state.volume; }
  set Volume(v) { this.send({ action: "volume", value: Math.min(Math.max(v, 0), 1) }); }
  // Position isn't announced with PropertiesChanged (per the spec); clients read it, so it's extrapolated.
  get Position() {
    const s = this.state;
    return us(s.position + (s.status === "Playing" ? (Date.now() - s.at) / 1000 : 0));
  }
  trackPath() {
    const t = this.state.track;
    return t ? `/io/github/bbuckleymain/orchard/track/${String(t.id).replace(/[^A-Za-z0-9_]/g, "_") || "0"}` : NO_TRACK;
  }
  get Metadata() {
    const t = this.state.track;
    if (!t) return { "mpris:trackid": new Variant("o", NO_TRACK) };
    const m = {
      "mpris:trackid": new Variant("o", this.trackPath()),
      "xesam:title": new Variant("s", t.title || ""),
      "xesam:artist": new Variant("as", [t.artist || ""]),
    };
    if (t.length > 0) m["mpris:length"] = new Variant("x", us(t.length));
    if (t.album) m["xesam:album"] = new Variant("s", t.album);
    if (t.albumArtist) m["xesam:albumArtist"] = new Variant("as", [t.albumArtist]);
    if (t.art) m["mpris:artUrl"] = new Variant("s", t.art);
    if (t.trackNumber) m["xesam:trackNumber"] = new Variant("i", t.trackNumber);
    if (t.url) m["xesam:url"] = new Variant("s", t.url);
    return m;
  }
  get CanGoNext() { return true; }
  get CanGoPrevious() { return true; }
  get CanPlay() { return true; }
  get CanPause() { return true; }
  get CanSeek() { return !!this.state.track; }
  get CanControl() { return true; }

  Next() { this.send({ action: "next" }); }
  Previous() { this.send({ action: "previous" }); }
  Pause() { this.send({ action: "pause" }); }
  PlayPause() { this.send({ action: "playpause" }); }
  Stop() { this.send({ action: "pause" }); }
  Play() { this.send({ action: "play" }); }
  Seek(offset) { this.send({ action: "seekby", value: Number(offset) / 1e6 }); }
  SetPosition(trackId, position) { if (trackId !== this.trackPath()) return; this.send({ action: "seek", value: Number(position) / 1e6 }); }
  OpenUri() {}
  Seeked(position) { return position; }
}
Player.configureMembers({
  properties: {
    PlaybackStatus: { signature: "s", access: ACCESS_READ },
    Rate: { signature: "d", access: ACCESS_READWRITE },
    MinimumRate: { signature: "d", access: ACCESS_READ },
    MaximumRate: { signature: "d", access: ACCESS_READ },
    Volume: { signature: "d", access: ACCESS_READWRITE },
    Position: { signature: "x", access: ACCESS_READ },
    Metadata: { signature: "a{sv}", access: ACCESS_READ },
    CanGoNext: { signature: "b", access: ACCESS_READ },
    CanGoPrevious: { signature: "b", access: ACCESS_READ },
    CanPlay: { signature: "b", access: ACCESS_READ },
    CanPause: { signature: "b", access: ACCESS_READ },
    CanSeek: { signature: "b", access: ACCESS_READ },
    CanControl: { signature: "b", access: ACCESS_READ },
  },
  methods: {
    Next: {}, Previous: {}, Pause: {}, PlayPause: {}, Stop: {}, Play: {},
    Seek: { inSignature: "x" },
    SetPosition: { inSignature: "ox" },
    OpenUri: { inSignature: "s" },
  },
  signals: { Seeked: { signature: "x" } },
});

// Start the service. Returns update(state) for the renderer's reports, or null where there's no session bus.
async function start({ send, raise, quit }) {
  let bus;
  try {
    bus = dbus.sessionBus();
    const root = new Root({ raise, quit });
    const player = new Player(send);
    bus.export(PATH, root);
    bus.export(PATH, player);
    await bus.requestName(BUS_NAME, 0);
    return function update(next) {
      const s = player.state, changed = {};
      const trackChanged = next.track && (!s.track || next.track.id !== s.track.id || next.track.length !== s.track.length);
      if (trackChanged || (!next.track && s.track)) { s.track = next.track || null; changed.Metadata = player.Metadata; changed.CanSeek = player.CanSeek; }
      if (next.status && next.status !== s.status) { s.status = next.status; changed.PlaybackStatus = s.status; }
      if (typeof next.volume === "number" && next.volume !== s.volume) { s.volume = next.volume; changed.Volume = s.volume; }
      if (typeof next.position === "number") {
        // A jump the extrapolation didn't predict is a seek; tell clients so they don't count it as listening.
        const expected = Number(player.Position) / 1e6;
        s.position = next.position; s.at = Date.now();
        if (next.seeked || (!trackChanged && Math.abs(expected - next.position) > 2.5)) player.Seeked(us(next.position));
      }
      if (Object.keys(changed).length) Interface.emitPropertiesChanged(player, changed, []);
    };
  } catch (e) {
    console.warn("[Orchard] MPRIS unavailable:", e?.message || e);
    try { bus?.disconnect(); } catch {}
    return null;
  }
}

module.exports = { start };
