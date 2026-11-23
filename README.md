# Orchard

Orchard plays Apple Music and the music you own in the same window. Apple's MusicKit JS runs inside a
castLabs Electron build with Widevine, the way Cider does it, while Orchard scans and tags your local files
itself, and both sources share one transport and one queue.

## What it does

### Listening

Home mixes Apple's recommendations with a **Continue listening** row and albums from disk. Search covers the
catalogue and your files together, with **All / Apple Music / Your files** scopes and results that update as
you type.

**Shuffle albums** plays whole records in a random album order, keeping each album's own track order. It is in
Library → Albums and in Local Files. If you only want a few, Cmd/Ctrl-click their covers first and use the
selection bar.

The expanded player has a Queue tab. Drag to reorder, remove a track, clear Up Next, or use shuffle and
repeat. Media keys, the desktop panel and scrobblers like Pano Scrobbler reach Orchard through MPRIS, for
both Apple Music and local files.

### Your files

Add folders or individual files. Orchard walks them, reads tags, lengths and cover art, and remembers the
library between launches. FLAC is the primary format (STREAMINFO, VORBIS_COMMENT, PICTURE). Orchard reads MP3
(ID3v2), M4A/MP4, WAV and AIFF too, and OGG/Opus play with file-name metadata.

Local Files has All, Albums, Artists and Songs tabs. Shuffle albums plays every local record in a random
order, each in its own track order.

You can build playlists by hand: create a local playlist, then add or remove songs, albums or artists from
any right-click menu. You can add to Apple playlists from the same menu when you are signed in.

The five-band equalizer (Flat, Warm, Bright, Vocal, Bass) works on local files only. Web Audio cannot process
Apple's protected stream. The library stays in Electron's user data directory, and Orchard uploads nothing.

### Suggested

**Suggested** reads your Last.fm listening. With the API key **and secret** saved, press **Connect Last.fm**
once: Orchard asks Last.fm for the same recommendations its own Suggested page shows. Without connecting, it
falls back to the artists topping the genres you listen to most (or the Last.fm charts with no username). A
couple of records from each suggestion are looked up in the Apple catalogue, and their songs become a
**Suggested Music** playlist in your Apple Music library. The playlist is replaced when a new day's set is
built, so it always holds one day's suggestions. With **Auto-create daily** on, it is rebuilt the first time
Orchard opens each day; the buttons in Settings build it immediately. It needs your own free Last.fm API key.

### Lyrics

The lyrics panel (`Y` or `L`) reads a `.lrc` next to the file first, then lyrics embedded in the file
(FLAC `LYRICS`, ID3 `USLT`, MP4 `©lyr`). Timed lines highlight and scroll, clicking a line seeks there, and
untimed lyrics show as plain text.

After a scan Orchard asks LRCLIB about tracks without timed lyrics. Orchard writes a timed answer into the
FLAC tag and replaces a plain sidecar with it. If only plain text exists, it uses that. Right-click a local
song for **Fetch lyrics**, or use **Re-download every lyric…** in Settings to ask again for the whole library.

Word-by-word timing comes from NetEase when **Look for word-by-word lyrics** is on, and the line fills word
by word. Instrumental gaps of five seconds or more show three growing dots.

The full-screen stage (`F`, or the mic button in the player bar) puts large words over the artist's Deezer
photo, cached after the first play. The current line lights up, clicking seeks, and `Esc` leaves.

### The window

The accent, tints and background come from the current cover and crossfade when the track changes. Two
themes share that palette: **Glass** (light) and **Night** (dark glass).

There are five destinations: Home, Search, Library, Local Files and Suggested. Library keeps Albums, Songs,
Artists, Playlists, Recently Added, Recently Played, Most Played, Favorites and Radios as filters. The icon is
a flat green apple with a beamed music note.

## Install

```bash
./install.sh
```

The script copies the app to `~/.local/share/orchard`, writes `~/.local/bin/orchard`, and adds an
application-menu entry and icons. Run it again after changing the code. `./install.sh --remove` uninstalls the
app and leaves your sign-in and settings in `~/.config/Orchard` alone.

The first install fetches castLabs Electron; the first launch downloads Widevine. `.npmrc` already allows the
castLabs tarball and the Electron install script, and the installer fetches the binary itself.

To run from the source folder:

```bash
npm install
npm start
```

If Electron dies at startup with a `zygote_host_impl_linux.cc` error, a `CHROME_DESKTOP` variable inherited
from another Chromium app causes it. The installed launcher clears it; for a manual start, run
`unset CHROME_DESKTOP` first.

## Windows

```bash
npm install
npm run dist:win
```

The installer and portable zip land in `dist/`. Build on Windows, or cross-build from Linux with wine.
Widevine on Windows needs a VMP-signed castLabs build: install `castlabs-evs`, sign up once, and
`npm run dist:win` signs the app. Set `ORCHARD_REQUIRE_VMP=1` to fail an unsigned build instead of warning.

## Keys

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Seek 5 seconds |
| `Shift` + `←` / `→` | Previous / next |
| `↑` / `↓` | Volume |
| `M` | Mute |
| `Y` or `L` | Lyrics panel |
| `F` | Full-screen lyrics stage |
| `Q` | Queue |
| `E` | Expand / collapse the player |
| `Backspace` | Back |
| `/` or `Ctrl`+`F` | Search |
| `Esc` | Close menus, player, stage or settings |

## Where the data lives

Electron's user data directory (`~/.config/Orchard` on Linux):

- `account.bin`: the encrypted Apple Music token, when a system keyring is available.
- `local-library.json`: scan roots and track metadata.
- `local-cache.json`: tag-read cache.
- `local-lyrics.json`: which files were checked for lyrics and whether the result was timed.
- `artist-photos.json`: Deezer artist-photo URLs.
- `covers/`: cover art extracted from files.
- `Local Storage/`: preferences, local playlists, likes and play counts (scoped to the app's origin).

## Limits

- Full songs need an Apple Music subscription; without signing in, Apple tracks play as 30-second previews.
  Local files need no account.
- The equalizer only works on local files.
- Orchard embeds lyrics into FLAC tags; MP3, M4A, WAV and AIFF use the `.lrc` sidecar, which it reads first.
- Orchard matches Deezer photos by artist name and caches them, so an ambiguous name can pick the wrong photo.
- Install Pano Scrobbler and allow it to see "Orchard" once.

## Working on it

- `npm test` runs the parser, queue, lyrics, Last.fm and recommendations tests with Node's built-in runner; they
  build their own fixtures and need no network.
- `node --check <file>` is the only static check. There is no lint or build step for the renderer.
- Close Orchard before running `./install.sh` again.

## Project docs

- `PRODUCT.md`: what the app is for and the product constraints.
- `DESIGN.md`: tokens, type scale and component specs.
- `AGENTS.md`: notes for coding agents working in this repo.
- `CREDITS.md`: the projects and services Orchard draws on.

## Credits and license

Orchard's layout and original look started with GlassPlayer, and the MusicKit-in-Electron approach follows
Cider. castLabs Electron supplies Widevine. Lyrics come from Apple Music, NetEase, LRCLIB and, optionally,
Musixmatch; see `CREDITS.md`.

Orchard is not affiliated with Apple. Apple Music is a trademark of Apple Inc.

Orchard is GPL-3.0, the same license as GlassPlayer.
