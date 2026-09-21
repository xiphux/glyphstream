# Changelog

What changed for people using Glyphstream, newest first.

Internal work — refactors, tests, dependency bumps, CI — is deliberately absent,
and so is any fix to a problem that never reached a release. See
[`docs/`](docs/) for how a feature actually works; entries here only say that it
arrived.

## Unreleased

### Added

- The composer follows an aspect ratio named in the prompt itself, so asking for
  a wide banner sets the shape without touching the picker.
- The debug panel reports viewport units and safe-area insets.

### Fixed

- The send button is no longer pushed out of the composer on narrow phones. The
  aspect-ratio glyph collapses to make room instead, keeping the model name
  readable.
- The installed app fills the viewport again on iOS 27, and its status bar takes
  the colour of the surface behind it rather than blurring over it.

## v0.39.0

### Added

- **Aspect ratios for image and video generation.** Pick a shape in the
  composer, including a Default that defers to whatever each model prefers. The
  choice follows a conversation across fan-out branches and edit resends, and
  every generation records the shape it was rendered at.
- **Favorites.** Star a picture from the lightbox and filter the gallery down to
  what you have starred. Also exposed over the media API.
- Delete a single fan-out variation from the lightbox and move straight to the
  next one. It stays deleted across an app resume.

### Fixed

- Regenerating an image uses the model that produced it rather than the current
  default.
- The lightbox metadata line names the endpoint an image came from.
- A fan-out branch that has not reached the gate yet shows "Starting…" instead
  of appearing stalled.
- After deleting a batch from the lightbox, it lands on the image its slot
  actually shows.
- Memory recall breaks ties by insertion order, so the same query returns the
  same results instead of reshuffling.
- Deleting a user now stops their in-flight generations and unlinks their media
  files.
- A generation whose conversation was deleted mid-stream stops quietly instead
  of erroring.
- Repeated tool-approval resumes no longer accumulate duplicate tool entries.
- The skills and snippets buttons in settings use the correct accent colour.
