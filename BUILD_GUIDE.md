# Production Buddy — Build & Release Guide

> Everything needed to build, sign, notarize, and release a new version of Production Buddy for macOS (arm64).
> Follow every step in order.

---

## Credentials & Setup

### Apple (codesign + notarize)
- **Apple ID**: `alexthebritgordon@gmail.com`
- **App-specific password**: `bhrp-sljp-hlud-outa`
- **Team ID**: `9VRW78GQHM`
- **Signing identity**: `Developer ID Application: Alex Gordon (9VRW78GQHM)` — SHA: `E3C6B97B885843868879D7360252DE1E1EAF732E` (the cert installed in this Mac's Login keychain; explicitly set in `package.json` `mac.identity` so we don't depend on auto-detection)

### GitHub
- **Account**: `FillThatPDF` (gh CLI is already authenticated)
- **Releases repo**: `FillThatPDF/ProductionBuddy-releases`
- **Source repo**: same — the build folder pushes its source to this repo's `main` branch

### Required env vars (in `~/.zshrc`)
```bash
export NOTARIZE_APPLE_ID="alexthebritgordon@gmail.com"
export NOTARIZE_APP_PASSWORD="bhrp-sljp-hlud-outa"
export NOTARIZE_TEAM_ID="9VRW78GQHM"
```

> **Why uniquely named?** electron-builder's auto-detection greps for the standard `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` names — those would activate its buggy built-in notarizer (crashes with `Cannot destructure property 'appBundleId'`). The `scripts/notarize.js` afterSign hook reads `NOTARIZE_*` and runs `@electron/notarize` directly. Safe to keep set globally.

---

## Directory Structure

```
/Users/36981/Desktop/Prdouction AI/InDesignEditor/
├── main.js                   ← Electron main process
├── renderer.js               ← UI logic
├── index.html, styles.css    ← UI layout
├── finding_meta.js           ← QA finding metadata (titles + fixes)
├── package.json              ← Version + electron-builder config
├── BUILD_GUIDE.md            ← (this file)
├── assets/
│   ├── icon.icns             ← macOS icon (multi-resolution)
│   ├── icon.png              ← 1024px master
│   ├── icon.iconset/         ← All resolutions (excluded from build)
│   └── build_icon.py         ← Re-runnable icon generator
├── build/
│   └── entitlements.mac.plist ← Hardened-runtime entitlements
├── scripts/
│   ├── notarize.js           ← afterSign hook → notarizes the .app
│   └── notarize-dmg.sh       ← Post-build DMG notarization + stapling
├── jsx/
│   ├── apply_edits_v2.jsx    ← Main InDesign edit + QA script (template)
│   ├── inspect_doc.jsx       ← Read-only doc inspection (template)
│   ├── relink.jsx            ← Auto-relink + re-export (template)
│   ├── re_export.jsx         ← Re-export after font activation
│   └── illustrator/
│       ├── apply_edits.jsx   ← Illustrator edit + QA script
│       └── inspect_doc.jsx   ← Illustrator inspection
├── python/
│   ├── orchestrate.py        ← Main pipeline driver
│   ├── orchestrate.spec      ← PyInstaller spec
│   ├── pdf_text.py           ← pikepdf + pypdfium2 + pdfplumber wrapper
│   ├── hires_swap.py         ← Stock-photo ID extraction + hi-res match
│   ├── local_classifier.py   ← Rule-based annotation classifier
│   ├── ollama_client.py      ← Local-LLM escalation
│   ├── font_activator.py     ← FontExplorer X Pro activation
│   ├── engines/              ← Per-app dispatch (InDesign / Illustrator)
│   └── qa_checks/            ← QA modules (hyperlinks, spelling, recovery)
├── pyenv/                    ← arm64 Python 3.14 venv (build-time only, gitignored)
└── dist/                     ← Final DMGs, ZIPs, blockmaps, latest-mac.yml
```

---

## Step-by-Step: New Version Release

### 1. Bump version

`package.json` only — `version` field. No other files need editing for a version bump.

### 2. Apply code changes

Edit Python in `python/`, JSX in `jsx/`, JS/HTML/CSS in the repo root, and re-test in dev mode (`npm start`) BEFORE rebuilding the bundle. Dev mode skips the PyInstaller bundle and runs `python/orchestrate.py` directly via the venv — fast iteration.

### 3. Rebuild the PyInstaller engine

The Python engine ships as a self-contained `--onedir` bundle (Python interpreter + pikepdf + pypdfium2 + pdfplumber + pyspellchecker + all our Python source). Users don't need Python installed.

```bash
cd "/Users/36981/Desktop/Prdouction AI/InDesignEditor"
source pyenv/bin/activate
cd python && rm -rf build dist
pyinstaller --noconfirm --clean orchestrate.spec
```

Expected output: `python/dist/orchestrate/` containing `orchestrate` (the binary) + `_internal/` (its libraries). About 83 MB.

Sanity-test the bundle runs without system Python:
```bash
cd "/Users/36981/Desktop/Prdouction AI/InDesignEditor"
env -i PATH="/usr/bin:/bin" HOME="$HOME" \
  ./python/dist/orchestrate/orchestrate '{"pdfPath":"/x","inddPath":"/x","outputDir":"/tmp/pb-test"}'
```

You should see `[orchestrate] step 1: extracting PDF annotations…` followed by an expected error about the missing PDF — that confirms Python ran end-to-end without `python3` on PATH.

### 4. Build the DMG (signed + notarized)

```bash
cd "/Users/36981/Desktop/Prdouction AI/InDesignEditor"
source <(grep -E '^export NOTARIZE_' ~/.zshrc)   # load credentials in non-interactive bash
rm -rf dist/
npm run build:arm64
```

What this does:
1. electron-builder packages the .app
2. Codesigns with Developer ID Application (`E3C6B97B…`), hardened runtime + entitlements
3. `afterSign` hook (`scripts/notarize.js`) submits the .app to Apple notary service via `@electron/notarize`. Look for `✅ Notarization complete!` (~1–3 minutes).
4. Builds the DMG and the auto-update ZIP, plus blockmaps and `latest-mac.yml`.

> **Expected harmless line:** `skipped macOS notarization reason='notarize' options were unable to be generated`. That's electron-builder's own notarizer being skipped — correct, our afterSign hook handles it.

Expected output in `dist/`:
```
ProductionBuddy-X.Y.Z-arm64.dmg          ← Apple Silicon installer
ProductionBuddy-X.Y.Z-arm64.dmg.blockmap ← Delta-update reference
ProductionBuddy-X.Y.Z-arm64.zip          ← electron-updater download target
ProductionBuddy-X.Y.Z-arm64.zip.blockmap
latest-mac.yml                            ← Auto-update manifest
```

### 5. Notarize + staple the DMG

`afterSign` notarized the .app BEFORE the DMG was assembled — Apple has never seen the DMG itself. Submit it separately so Gatekeeper can validate offline:

```bash
cd "/Users/36981/Desktop/Prdouction AI/InDesignEditor"
source <(grep -E '^export NOTARIZE_' ~/.zshrc)
./scripts/notarize-dmg.sh "dist/ProductionBuddy-${NEW_VER}-arm64.dmg"
```

Watch for `✅ <file> notarized + stapled`. Takes 1–3 minutes for Apple.

### 6. Verify Gatekeeper accepts

```bash
APP="dist/mac-arm64/Production Buddy.app"
spctl -a -vvv "$APP"           # should print: "accepted   source=Notarized Developer ID"
xcrun stapler validate "$APP"  # should print: "The validate action worked!"
xcrun stapler validate "dist/ProductionBuddy-${NEW_VER}-arm64.dmg"
```

If any of those fail, **do not ship** — debug first (see Troubleshooting).

### 7. Push source to the release repo

```bash
cd "/Users/36981/Desktop/Prdouction AI/InDesignEditor"
export GIT_DIR="/Users/36981/Desktop/Prdouction AI/InDesignEditor/.git"
git add -A
git commit -m "vX.Y.Z: <short summary>"
git push origin main
```

> The build folder has its own `.git` (initialized once with `git init`). It pushes to `https://github.com/FillThatPDF/ProductionBuddy-releases.git` `main`.

### 8. Create the GitHub release

```bash
VER="X.Y.Z"
DIST="dist"

gh release create "v${VER}" \
  --repo FillThatPDF/ProductionBuddy-releases \
  --title "v${VER} — <short title>" \
  --notes "<release notes — describe what's new>" \
  "$DIST/ProductionBuddy-${VER}-arm64.dmg" \
  "$DIST/ProductionBuddy-${VER}-arm64.dmg.blockmap" \
  "$DIST/ProductionBuddy-${VER}-arm64.zip" \
  "$DIST/ProductionBuddy-${VER}-arm64.zip.blockmap" \
  "$DIST/latest-mac.yml"
```

> If `gh release create` succeeds but a single asset upload fails (rare — usually the largest file), use `gh release upload v${VER} <missing-file> --repo FillThatPDF/ProductionBuddy-releases` to retry just that one.

### 9. Verify the release

```bash
gh release view "v${VER}" --repo FillThatPDF/ProductionBuddy-releases --json assets -q '.assets[] | "\(.name)\t\(.size)"'
```

All 5 assets should show up:
```
ProductionBuddy-X.Y.Z-arm64.dmg
ProductionBuddy-X.Y.Z-arm64.dmg.blockmap
ProductionBuddy-X.Y.Z-arm64.zip
ProductionBuddy-X.Y.Z-arm64.zip.blockmap
latest-mac.yml
```

Existing installs will detect the new version on next launch (electron-updater pings the GitHub releases page ~1.5s after the renderer paints), download in the background, and show the "Restart to Update" banner.

---

## Troubleshooting

### `skipped macOS notarization reason='notarize' options were unable to be generated`
- **Normal and expected.** electron-builder's auto-notarizer was skipped (correct — the `afterSign` hook handles notarization). Look for `✅ Notarization complete!` immediately after.

### `✅ Notarization complete!` doesn't appear
- Check env vars are set in the build shell:
  ```bash
  echo "$NOTARIZE_APPLE_ID $NOTARIZE_TEAM_ID ${NOTARIZE_APP_PASSWORD:+set}"
  ```
  All three should print non-empty. If blank, source `~/.zshrc` or set them inline before the build.
- If the app-specific password was revoked at appleid.apple.com, generate a new one and update `~/.zshrc`.

### Code signature validation fails (`code has no resources but signature indicates they must be present`)
- This was the v1.0.0 / v1.0.1 / v1.0.2 ad-hoc-signing bug. Symptom: the .app inside the DMG is valid but Squirrel.Mac rejects auto-update.
- Fix: don't use ad-hoc signing (`identity: null`). Always use the real Developer ID via `mac.identity` in `package.json`.

### `spctl -a -t open …DMG` says "rejected: no usable signature"
- **This is fine for DMGs.** DMGs aren't code-signed — only stapled with a notarization ticket. The right verification for DMGs is `xcrun stapler validate <file>.dmg`. The `.app` inside is the thing Gatekeeper actually checks at launch (`spctl -a -vvv "Production Buddy.app"`).

### `xcrun stapler staple` fails with "could not validate ticket"
- Apple sometimes takes longer than the 1–3 min average. Re-run after a few minutes; the notarization is sticky (you don't have to re-submit, just re-staple).

### Auto-update doesn't trigger
- Open `~/Library/Logs/Production Buddy/main.log` — electron-updater logs there.
- Confirm the running install's `Info.plist` has the previous version (`defaults read /Applications/Production\ Buddy.app/Contents/Info.plist CFBundleShortVersionString`).
- Confirm the new release's `latest-mac.yml` is uploaded and reachable (`gh release view`).

### Bundle (`python/dist/orchestrate/`) fails to launch standalone
- Most often a missing hidden import. Add to `hiddenimports` in `python/orchestrate.spec`, rebuild the bundle, retest.
- If pdfplumber / pypdfium2 / pikepdf raises at import, ensure the venv has the matching version installed (`pip list`).

### node_modules missing or broken
- `cd InDesignEditor && rm -rf node_modules package-lock.json && npm install --no-audit --no-fund`
- The `postinstall` script runs `electron-builder install-app-deps`, which is sometimes flaky on the first install — rerun if it errors.

### node_modules/.bin/ entries are regular files instead of symlinks
- Symptom: `electron-builder` fails with `Cannot find module './out/cli/cli'`.
- Cause: `node_modules` was copied with a tool that dereferences symlinks (e.g. `cp -L`, some Finder copies, or rsync with the wrong flags). Once that happens it propagates forward through every subsequent copy.
- Fix: `rm -rf node_modules && npm install --ignore-scripts` (npm rebuilds the symlinks correctly). The `--ignore-scripts` flag avoids the `electron-builder install-app-deps` post-install if it's flaky.
- Verify: `ls -la node_modules/.bin/electron-builder` should show `→ ../electron-builder/cli.js`, not a regular file.

### `pyenv/` was copied from another version and shebangs point to a stale path
- Symptom: `dyld: Library not loaded` when running anything in `pyenv/bin/`, or `pyenv/bin/pyinstaller` exec-fails with "No such file or directory".
- Cause: venvs hardcode the absolute path of the Python interpreter at creation time. Copying `pyenv/` between version folders (e.g. via rsync) carries the original path forward — when that original location stops existing, every binary in the venv breaks.
- Fix: recreate from system Python (do NOT copy `pyenv/` from an old version):
  ```bash
  cd "/Users/36981/Desktop/Prdouction AI/InDesignEditor-${NEW_VER}"
  rm -rf pyenv
  python3 -m venv pyenv
  ./pyenv/bin/python3 -m pip install --upgrade pip
  ./pyenv/bin/python3 -m pip install pyinstaller pikepdf pdfplumber pdfminer.six pypdfium2 Pillow pyspellchecker
  ```
  Verify: `./pyenv/bin/python3 -c "import pikepdf, pdfplumber, pypdfium2, PIL"` runs clean.

### Verify the signing identity exists before building
- The `mac.identity` SHA in `package.json` must match a cert in the Login keychain. If the cert was reinstalled the SHA changes and electron-builder skips signing with `Identity name is specified, but no valid identity with this name in the keychain`.
- Check: `security find-identity -v -p codesigning | grep "Developer ID Application"` — confirm the SHA matches `package.json`. If it doesn't, either update `package.json` to the new SHA or re-import the previous cert from a backup `.p12`.

---

## One-time setup (already done on this machine)

For reference, in case the cert/credentials need to be re-installed:

### Re-install the Developer ID certificate
1. Sign in at https://developer.apple.com → Certificates, Identifiers & Profiles
2. Download the Developer ID Application cert (.cer)
3. Double-click to install in the Login keychain
4. Verify: `security find-identity -v -p codesigning | grep "Developer ID Application"`

### Re-create the keychain profile (legacy fallback only)
The afterSign hook prefers `NOTARIZE_*` env vars but falls back to a keychain profile:
```bash
xcrun notarytool store-credentials "ProductionBuddy" \
  --apple-id "alexthebritgordon@gmail.com" \
  --team-id "9VRW78GQHM" \
  --password "bhrp-sljp-hlud-outa"
```

### Regenerate the app icon
```bash
cd "/Users/36981/Desktop/Prdouction AI/InDesignEditor/assets"
python3 build_icon.py
```
Produces `icon.png`, `icon.iconset/`, and `icon.icns` from the script's parameters. Edit the script to change the design.

---

## Auto-update flow (how it works end-to-end)

1. App launches. `main.js` waits for `did-finish-load` then calls `autoUpdater.checkForUpdatesAndNotify()` after a 1.5s delay.
2. electron-updater fetches `https://github.com/FillThatPDF/ProductionBuddy-releases/releases/latest/download/latest-mac.yml`.
3. If the manifest's version > current, electron-updater downloads the matching `.zip` to `~/Library/Caches/production-buddy-updater/pending/`.
4. Main sends `update-available`, then `update-download-progress`, then `update-downloaded` IPC events to the renderer.
5. The renderer's banner (registered synchronously at module load — see `renderer.js`) shows up at the top of the window: "🚀 A new version is available (v1.0.X) — Downloading… → Restart to Update".
6. User clicks "Restart to Update" → `ipcRenderer.invoke("install-update")` → main calls `autoUpdater.quitAndInstall()` → Squirrel.Mac validates the downloaded bundle's signature, replaces the .app, relaunches.

For step 6 to work the new version's signature must be valid. That's why every release MUST be properly codesigned + notarized; ad-hoc signing breaks Squirrel's validation.
