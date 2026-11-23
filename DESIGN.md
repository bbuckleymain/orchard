# Orchard — Design System

Surface: the application window. Mode: **Operate**. Familiarity, density and speed beat spectacle; the one
expressive moment is the cover-art tint moving through the window. This file is the contract the CSS and
`ui/app.js` implement.

## Token layers

Primitive → semantic → component. Rules reference semantic or component tokens; raw values live only in the
`:root` block of `ui/style.css` and the Night overrides in `ui/themes.css`.

### Semantic colour

| Token | Purpose | Rule |
|---|---|---|
| `--ink` | primary text | ≥7:1 on the lightest glass |
| `--ink-2` | secondary text | ≥4.5:1 |
| `--ink-3` | tertiary text, labels, placeholders | ≥4.5:1 — never decorative |
| `--ink-4` | hairlines, disabled marks | decorative only, never body text |
| `--line`, `--line-strong` | separators | non-text |
| `--panel`, `--panel-2`, `--panel-strong`, `--panel-solid` | glass surfaces | border + shadow, never both for emphasis |
| `--accent` | sampled cover colour, decorative fills | set by `paintPalette()` |
| `--accent-strong` | accent text/icons | derived for the active theme |
| `--accent-button` | accent fill behind text | computed until white or near-black reaches 4.5:1 |
| `--accent-ink` | text/icon on `--accent-button` | computed with the fill |
| `--tint-a`, `--tint-b`, `--bg-base` | room tint and base | set by `paintPalette()` |

Accent, tint and base are recomputed per track. The fixed light/dark surfaces stay in `style.css` / `themes.css`;
only the album-derived values are inline on `:root`.

### Type scale

| Token | Value | Use |
|---|---|---|
| `--text-xs` | 11.5px | uppercase labels, badges, kickers |
| `--text-sm` | 12px | secondary body, metadata, chips, buttons |
| `--text-md` | 12.5px | nav items, toast copy, player sub |
| `--text-base` | 13px | card titles, track titles |
| `--text-lg` | 15px | pane titles |
| display | 18–30px | page and hero headings |

Body copy never goes below 12px. The 11.5px tier is for short labels only.

### Space, radius, motion

- Spacing steps: 4, 6, 8, 10, 14, 18, 24, 28px.
- Radius: `--r-sm` 10, `--r-md` 14, `--r-lg` 20, `--r-xl` 26; pills use 99.
- Motion: `--ease` for entrances, `--ease-in` for exits. 140–320ms. Only `opacity` and `transform` move;
  colour/background transitions are allowed. `prefers-reduced-motion` collapses everything to 0.001ms.

## Component specs

| Component | Default | Hover | Active / selected | Focus |
|---|---|---|---|---|
| Nav item | ink-2, transparent, 10px radius | `--hover`, ink | `--accent-soft`, ink, accent-strong icon | 2px accent ring |
| Primary button | `--accent-button`, `--accent-ink`, 34px, 10px radius | brightness 1.06 | scale .98 | accent ring |
| Icon button | 34px (26px tiny), 10px radius, ink-2 | `--hover` | scale .94 | accent ring |
| Chip / filter | 12px, 4×11px padding, panel, 99 radius | brighter panel | `--accent-button`, `--accent-ink` | accent ring |
| Card (song) | panel .38, panel-border, 14px radius | translateY(-2px), shadow-sm | accent-soft + accent ring, 3px accent bar | accent ring |
| Cover card | 16px art radius, shadow | lift 3px, art scale 1.035 | accent title | accent ring |
| Track row | 7-col grid, 40px art, 12px metadata | `--hover` | accent-faint gradient, accent title | accent ring |
| Toast | fixed above mini bar, z 90, dark .9, 620px max, wraps | — | errors persist 12s | `role=status` |
| Selection bar | full-width glass strip under the topbar, 14px radius | — | "N albums selected", Shuffle albums, Clear | buttons |
| Lyrics stage | full-screen dark overlay, artist photo + scrim, large words | — | current line white, past dim, click seeks | Esc closes |
| Filter bar / scope bar | flex wrap, 6px gap, 20px bottom margin | — | active chip filled | per chip |
| Volume bar | vertical glass chip above each mute button: 38px wide, 13px radius, 96px track, accent fill, white knob with accent ring, 11.5px number | opens on hover/focus, rises 6px, 160ms; stays while dragging | muted level greys the number | drag, wheel, arrows/Home/End |

### Shell contract

- Four destinations: **Home**, **Search**, **Library**, **Local Files**. Library filters (Albums, Songs,
  Artists, Playlists, Recently Added, Recently Played, Most Played, Favorites, Radios) live in the page, not
  the rail. The collapsed rail keeps one unique glyph and one specific tooltip per destination.
- Search has three scopes: All, Apple Music, Your files. Typing two characters switches to Search and
  debounces 280ms.
- Signed out: Home is local-first, Library shows a sign-in state with a Connect action, Local and Search
  keep working. No destination is a dead end.
- One settings door (titlebar gear; the account chip also opens the same sheet). One player exit (the
  collapse chevron). One Clear per queue (`Clear Up Next`, two-step with a 600ms double-click guard).

## Gestures

- Mini seek: pointer capture, 1:1 fraction tracking, `touch-action: none`, Home/End and arrow keys.
- Queue reorder: HTML5 drag with `drop-before` / `drop-after` marks; the playing track and history are
  immutable. The row keeps its grab cursor and dims while dragging.
- No swipe-only actions; every gesture has a button or keyboard equivalent.
