# Orchard — Product

Orchard is a desktop music player for people who both stream and own their music. It plays Apple Music
through Apple's own MusicKit JS inside castLabs Electron (Widevine), and it plays a local library —
mostly FLAC — from the same window, with the same transport, queue, lyrics and media-key integration.

## Who it is for

Someone at a desk or on a sofa, listening for an hour or more, often with the window open beside other
work. They care about sound quality, album art, and a player that gets out of the way. They may have a
large FLAC collection and an Apple Music subscription, and they do not want two applications.

## The job

- Find something to play quickly: from Apple Music's catalogue, their Apple library, or their own files.
- Keep the current song and the queue in view without opening another window.
- Let the music set the light of the room: the interface takes its tint from the current cover art.
- Play, pause, seek, skip, shuffle, repeat, queue, favourite and read lyrics from one consistent transport.
- Work with Linux media keys, the panel, and scrobblers through MPRIS; work with Windows media controls too.

## Product truth

- Apple Music streaming needs an Apple Music subscription and a sign-in. Without one, Apple returns
  30-second previews; Orchard says so rather than pretending.
- Apple's web player streams at 256 kbps AAC. Orchard locks that quality.
- Local files are the user's own; Orchard reads their tags and cover art, never edits or uploads them.
- Lyrics come from Apple Music, Musixmatch (with the user's key), NetEase and LRCLIB. Local files can also
  use a sidecar `.lrc` file next to the audio.
- The Last.fm tools only run when the user supplies their own API key. Connecting the account (key, secret and
  a session key) is optional and only makes Suggested read Last.fm's own recommendations; the key and secret
  are stored encrypted and never leave the main process.
- Suggested Music comes from Last.fm's own Suggested page, read in an app window after the user signs in to
  Last.fm there; without that sign-in it falls back to the similar-artist graph around what they play, minus
  their library. It is written to the user's Apple Music library as a playlist, replaced when a new day's set
  is made, and only when the user turns the daily toggle on.
- The Playlist Reviewer walks a playlist one song at a time, playing each as it appears, with keep and remove
  as the only decisions;
  removing is applied to the playlist immediately, so closing the reviewer keeps whatever was decided.
- Orchard is unofficial and not affiliated with Apple.
- Importing a Spotify playlist matches each track on Apple Music and writes a new playlist to the user's Apple
  Music library. With no credentials it reads Spotify's public embed page (first 50 tracks); a client id and
  secret, stored encrypted, switch it to the Web API for the whole playlist. Private playlists can't be read.

## Surface

The application window: a persistent sidebar, a scrollable library/content surface, a floating mini player,
an expandable now-playing view with queue, lyrics and equaliser, and a settings sheet. It is an Operate
surface: familiarity, density and speed beat spectacle. The one expressive moment is the cover-art tint
moving through the whole window as tracks change.

## Assumptions made for this redesign

- The uploaded screenshots are the approved visual reference.
- The old Aero, Night Aero and Catppuccin themes are replaced by two album-tinted themes: Glass (light) and
  Night (dark). A saved Catppuccin preference opens Night.
- Local library roots and files are remembered between launches, and are re-scanned on demand, not watched.
- Favourites and play counts are stored locally (Orchard does not have a private "favourites" API for all
  Apple content), so the sidebar's Favourites and Most Played views work for both sources.
