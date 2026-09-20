# Chrome Extensions

A monorepo of my Chrome extensions. Each top-level folder is one standalone,
independently versioned extension.

## Extensions

| Extension | Folder | Version | What it does |
|---|---|---|---|
| Hide Distracting Items | [`hide-items/`](hide-items/) | 1.0.0 | Hide any element on a page, like Safari's "Hide Distracting Item". Choices persist per site. |

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select the extension's folder, e.g. `hide-items/`.

Chrome tracks unpacked extensions by path — moving or renaming the folder
disables it. After editing files, press the reload button on the extension
card, then reload any open tabs.

## Versioning

Extensions version **independently**. Nothing here is shared or released together.

### 1. `manifest.json` is the source of truth

Chrome's version rules are not semver: 1–4 dot-separated integers, each 0–65535,
no letters or suffixes.

```json
{ "version": "1.2.0" }
```

Use `MAJOR.MINOR.PATCH` anyway, read as:

- **MAJOR** — behaviour people relied on changed, or stored data migrated.
- **MINOR** — new capability, backwards compatible.
- **PATCH** — fixes only.

For pre-release labels, add `version_name` — Chrome shows it in the UI and
ignores it when comparing versions:

```json
{ "version": "1.2.0", "version_name": "1.2.0 beta 1" }
```

### 2. Git tags are scoped by folder

One global `v1.0.0` tag would collide the moment a second extension ships. Scope
every tag with the folder name:

```
hide-items/v1.0.0
hide-items/v1.1.0
some-other-ext/v1.0.0
```

List one extension's history with `git tag -l 'hide-items/*'`.

### 3. One changelog per extension

`hide-items/CHANGELOG.md`, not a repo-wide one. A reader of that extension
should never have to filter out unrelated entries.

### 4. Prefix commit messages with the folder

```
hide-items: fix highlight flicker while scrolling
hide-items: bump to 1.1.0
```

`git log --oneline -- hide-items` then reads as that extension's history.

### Release checklist

```bash
# 1. bump "version" in <ext>/manifest.json
# 2. add the entry to <ext>/CHANGELOG.md
git add <ext>
git commit -m "<ext>: release v1.1.0"
git tag <ext>/v1.1.0
git push && git push --tags
```

Optionally attach a zip to a GitHub Release on that tag, titled `<ext> v1.1.0`:

```bash
cd <ext> && zip -r -X "../<ext>-1.1.0.zip" . -x ".*" -x "*.DS_Store"
```

Zips are gitignored — they are build output, not source.

### Rules worth knowing

- Chrome **refuses to install a lower version number** than the one already
  installed. Never reuse or walk back a version.
- The version only matters for packaged installs and store updates. An unpacked
  extension reloads straight from disk regardless.

## Adding a new extension

1. New top-level folder, kebab-case, matching the extension's name.
2. Its own `manifest.json` starting at `1.0.0`, and its own `CHANGELOG.md`.
3. Add a row to the table above.
4. Tag its first release `<folder>/v1.0.0`.
