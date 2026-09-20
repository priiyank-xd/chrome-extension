# Changelog

All notable changes to **Hide Distracting Items** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
