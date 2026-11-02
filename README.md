# Orchard

A simple Apple Music player for Linux, in the spirit of [GlassPlayer](https://github.com/Jonzu00/GlassPlayer), with a Frutiger Aero look.

It plays Apple Music the same way Cider does: Apple's own MusicKit JS runs inside
[castLabs Electron](https://github.com/castlabs/electron-releases) (Chromium with Widevine DRM),
using the public developer token from the music.apple.com web player and Apple's own sign-in page.

- Tabs: Home (For You), Search, Recent, Albums and Library (Playlists, Artists, Albums, Songs, Recently Added)
- Search songs, albums, artists and playlists together, or filter to one kind; artist pages show top songs and albums
- Paste a `music.apple.com` album or playlist link into the search box to load it
- Right-click anything for Play, Shuffle, Play Next, Add to Queue, Add to Library and Add to Playlist
- Shuffles are truly uniform: Fisher–Yates driven by the system's cryptographic random source, which also
  replaces `Math.random` for MusicKit's own shuffle button
- **Synced lyrics** (<kbd>L</kbd>), done the Aerwave way: the line being sung is sharp, the rest dim and blur with
  distance, words fill in as they're sung, instrumental breaks of 5 s or more show three dots that grow, click a line
  to jump there, and a ± timing nudge for lyrics that run early or late. Sources, best first: Apple Music's own
  (timed by the syllable, with background vocals and duet sides, the way Cider shows them), NetEase (word by word),
  LRCLIB (line by line)
- **Queue** (<kbd>Q</kbd>): what's playing and up next, click to jump, shuffle and repeat; right-click a song,
  album or playlist for *Play Next* / *Add to Queue*. Drag songs in Up Next to rearrange them, remove one with its ×,
  or clear Up Next (click *Clear* twice); right-click a queued song to move it up, down, to the top or bottom. The
  song that's playing carries on through all of it
- Three themes in Settings → Appearance: **Aero** (the original sky-and-grass look), **Night Aero** (the same
  glossy glass after dark, with a moon and stars) and **Catppuccin** (Mocha: flat, soft and dark)
- Keyboard: <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> seek 5 s, <kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd>
  previous/next, <kbd>↑</kbd>/<kbd>↓</kbd> volume, <kbd>M</kbd> mute, <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>F</kbd> search
  (all listed in Settings). Scroll over the volume slider to change it, click the speaker to mute, hover the seek bar
  to see where you'd land, and click the song length to show the time left instead
- Streams at High Quality, 256 kbps AAC (the most Apple sends to web players), locked so it never drops to 64 kbps
- Its own MPRIS player on Linux (`org.mpris.MediaPlayer2.orchard`, "Orchard") with the real song length,
  album, artwork and position, so media keys, the panel and scrobblers like Pano Scrobbler work properly
  (allow "Orchard" in your scrobbler once; the name no longer changes between launches)

Needs an Apple Music subscription for full songs; without signing in you get 30 second previews.

## Install

```bash
./install.sh
```

This installs Orchard into `~/.local/share/orchard`, adds an `orchard` command in `~/.local/bin`, and puts
**Orchard** in your application menu with its apple icon. Run it again after changing the code to update the
installed copy; `./install.sh --remove` uninstalls it (your sign-in and settings in `~/.config/Orchard` stay).

The first run fetches castLabs Electron. npm 12 blocks remote tarballs and install scripts by default, so the
project's `.npmrc` allows the castLabs tarball and the installer fetches the Electron binary itself.
On first launch the Widevine CDM is downloaded automatically.

To run it from the source folder without installing: `npm start`.

To use your own Apple Developer token instead of the web player's, set `APPLE_MUSIC_DEVELOPER_TOKEN`.

### If it won't start

castLabs Electron's zygote crashes at startup (`zygote_host_impl_linux.cc ... Invalid argument`) when the
`CHROME_DESKTOP` environment variable is set, which happens when it's launched from inside another Chromium app's
terminal. The `orchard` launcher clears it; if you start Electron some other way, run `unset CHROME_DESKTOP` first.

## Windows

Orchard runs on Windows too. Build the installer and a portable zip (cross-builds from Linux with wine):

```bash
npm install
npm run dist:win
```

The files land in `dist/`: `Orchard-Setup-<version>-x64.exe` and `Orchard-<version>-win-x64.zip`.

**Widevine on Windows needs a VMP-signed build.** Apple's licence server, like most, only hands keys to
Electron builds that castLabs has signed (Cider's Windows build is signed the same way). Signing is free:

```bash
pip install --user castlabs-evs
python3 -m castlabs_evs.account signup
```

After that, `npm run dist:win` signs the app automatically (see `build/vmp-sign.js`). Set
`ORCHARD_REQUIRE_VMP=1` to make an unsigned build fail instead of only warning.

## Credits

Orchard's look and starting point come from [GlassPlayer](https://github.com/Jonzu00/GlassPlayer) by Jonzu00,
and the way it plays Apple Music (MusicKit JS in castLabs Electron, with the music.apple.com origin and sign-in)
comes from [Cider](https://github.com/ciderapp/Cider). Lyrics come from Apple Music, [LRCLIB](https://lrclib.net)
and NetEase. See [CREDITS.md](CREDITS.md) for the details.

Orchard is unofficial and not affiliated with Apple. Apple Music is a trademark of Apple Inc.

## License

GPL-3.0, same as GlassPlayer.
