# Credits

Orchard stands on other people's work. Thank you to everyone below.

## Projects that shaped Orchard

### GlassPlayer — the look and the starting point
[Jonzu00/GlassPlayer](https://github.com/Jonzu00/GlassPlayer) · GPL-3.0

Orchard began as an Apple Music client for GlassPlayer. Its layout comes from GlassPlayer's: the song list
on the left, the large now-playing card with the cover that grows while playing, the ambient glow behind it,
the pill tab switcher, the round transport buttons and the settings sheet. So does the idea of running a
streaming service's own web SDK inside the app (GlassPlayer does this with Spotify's Web Playback SDK), and
of reading a web player's public client token rather than asking the user for API keys (GlassPlayer does
this for SoundCloud). Orchard is licensed under the GPL-3.0, the same as GlassPlayer.

### Cider — how Apple Music is played
[ciderapp/Cider](https://github.com/ciderapp/Cider) · AGPL-3.0

Orchard plays Apple Music the way Cider does. No Cider code is copied, but the method is theirs:

- Apple's MusicKit JS running in [castLabs Electron](https://github.com/castlabs/electron-releases), whose
  Chromium carries the Widevine CDM, with `components.whenReady()` before the window opens
- serving the player page from `localhost`, turning `webSecurity` off and giving every request to Apple
  `music.apple.com` as its `Origin` and `Referer`, so Apple's APIs answer it as they would the web player
- signing in on the real music.apple.com in a separate window and handing the Music User Token to the player
- the MusicKit app identity (`name: "Apple Music"`, `build: "1978.4.1"`) and setting `PlaybackBitrate.HIGH`
- showing Apple's own syllable-timed lyrics (TTML), with background vocals and duet parts

## Software and services Orchard uses

- **[castLabs Electron for Content Security](https://github.com/castlabs/electron-releases)** (MIT): Electron
  with Widevine, which makes DRM playback possible on Linux
- **Apple MusicKit JS** and the **Apple Music API**: the player, the catalog and your library. MusicKit is
  loaded from Apple's CDN at run time and is not part of this repository.
- **[LRCLIB](https://lrclib.net)**: the open, community-run synced lyrics database
- **NetEase Cloud Music**: word-by-word lyrics for songs Apple has none for
- **[Musixmatch](https://developer.musixmatch.com)**: timed lyrics through its official API, with your own key

## Design

The visual style is a tribute to **Frutiger Aero**, the glossy sky, water, grass and bubbles aesthetic of
mid-2000s software and Windows Vista and 7, whose caption buttons Orchard's window controls imitate.

## Not affiliated

Orchard is an unofficial client. It is not affiliated with, endorsed by or sponsored by Apple, Cider,
NetEase or LRCLIB. Apple Music is a trademark of Apple Inc. You need your own Apple Music subscription to
play full songs.
