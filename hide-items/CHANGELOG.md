# Changelog

All notable changes to **Hide Distracting Items** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] - 2026-09-20

### Added
- Modal detection. Hovering a popup selects the whole modal — dialog plus its
  grey backdrop — and hides it as a single item. The highlight turns orange and
  the button reads "Hide Popup".
- Scroll unlock. Hiding a modal releases the site's scroll lock (`overflow:
  hidden` on `body`) while that modal is present, so the page isn't left frozen.
- Page vs. site scope. A segmented control in the toolbar chooses whether the
  items hidden in this session apply to the whole site or only this URL.
- iframe support. The content script runs in every frame. Hovering an `<iframe>`
  offers **Hide** (the frame as a unit) and **Inside**, which hands pointer
  control to the frame so elements within it can be picked. Counts from frames
  roll up into the top toolbar, and Apply/Cancel apply everywhere at once.
- Right-click menu: "Hide This Element on This Site", "…on This Page", and
  "Show All Hidden Here". A hide from the menu shows an Undo toast for 5s.
- Hold Option while hovering to skip modal expansion and pick a single element.

### Changed
- Icon is the glyph alone on a transparent background, no coloured plate.
- Rules are stored as objects (`{ s, scope, path?, unlock? }`). Selector strings
  written by 1.0.0 are migrated automatically and treated as site scope.

## [1.0.0] - 2026-09-20

### Added
- Toolbar click enters selection mode: every hideable block gets a faint outline.
- Hover highlight with a centered "Hide" button, Safari-style.
- Click an element or its Hide button to remove it, with a fade-out animation.
- Bottom toolbar with Cancel / Hide, and Show Hidden when the site has saved items.
- Keyboard: Escape cancels, Enter applies.
- Hidden elements persist per hostname in `chrome.storage.local` and reapply at
  `document_start` on later visits.
- Light and dark appearance.
