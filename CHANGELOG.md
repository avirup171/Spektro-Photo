# Changelog

All notable changes to Spektro Photo (formerly Image Viewer) are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Large photos open instantly.** The viewer shows the photo's thumbnail right away, at full window size, and swaps in the full-resolution image once it's ready, with a *Loading full size…* indicator in between. Flicking through with <kbd>←</kbd> <kbd>→</kbd> no longer shows empty frames, and big JPEGs no longer freeze the window for a moment when they first appear.
- **Smoother scrolling** in big folders: thumbnails far off screen aren't drawn, and a fast scroll no longer queues a thumbnail for every photo it passes, so the ones you stop on appear first.
- Smoother zoom: fast trackpad scrolling and pinching no longer drop steps, and the buttons, <kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> <kbd>1</kbd>, double-click and rotate glide instead of jumping.
- **Animations and transitions**: the grid, viewer and editor fade in, the info panel slides in, dialogs and buttons respond softly, thumbnails fade in as they load, and keyboard selection scrolls the grid smoothly. With *Reduce motion* turned on in your system settings, everything appears instantly.

### Developer
- `Viewer.tsx`: placeholder (thumb://) → size from the full image's header (polled per frame) → `img.decode()` → crossfade. Wheel and drag updates are coalesced to one per animation frame; `zoomTo` works from the latest state.
- `Library.tsx`: `useNearViewport` (one shared IntersectionObserver, 90 ms dwell) replaces `loading="lazy"`; tiles use `content-visibility: auto` with a computed `--tile-h`.
- `thumbs.rs` / `state.rs`: `preview://` has its own permits, so a HEIC opened in the viewer never waits behind grid thumbnails; thumbnail decodes leave two cores free for the UI.

## [0.1.4] - 2026-11-16

### Added
- **Rotate and flip** in the editor (<kbd>R</kbd>): rotate left / right, flip horizontal / vertical, with <kbd>←</kbd> <kbd>→</kbd> <kbd>H</kbd> <kbd>V</kbd>. Works together with crop and adjust in one save; a crop box stays on the same part of the photo when you rotate.
  - **Lossless for JPEG:** a JPEG that's only rotated or flipped isn't re-compressed. Spektro Photo changes its EXIF orientation flag instead, so the image data stays byte-for-byte identical.
  - In the viewer, after rotating the view with <kbd>R</kbd>, **Save rotation…** opens the editor with that rotation, ready to save.
- **Export** (<kbd>E</kbd> in the grid, viewer and editor): save a resized or converted copy anywhere, through the system's Save dialog.
  - Long edge: original, 3840, 2048, 1080 px or a custom size. Photos are never enlarged.
  - JPEG (with a quality slider) or PNG. Transparent areas become white in a JPEG.
  - Metadata: keep all, **remove location** (GPS is wiped; camera, lens and date stay), or remove all. The colour profile is always kept.
  - From the editor, the export includes the current crop, rotation and colour changes. HEIC photos (macOS) export straight to JPEG.
  - Your choices are remembered for next time. A toast offers *Show in Finder / Explorer* when done.

### Developer
- `edit/rotate.rs`: the `Rotate` op (clockwise quarter turns + optional mirror) and how two rotations combine, pinned against the image crate's 8 EXIF orientations. `src/edit/orientation.ts` mirrors it.
- `edit/lossless.rs`: walks the JPEG's segments and patches (or adds) the EXIF orientation; falls back to re-encoding when that isn't safe (XMP orientation, EXIF without an orientation tag).
- `tiff.rs`: small in-place EXIF edits (orientation, GPS removal) that never change the block's length.
- `export.rs`: `export_image` command. Renders first, then opens the Save panel from Rust, so the destination path never comes from the webview.
- Edit tools can now provide `rotation`, `reorient` and `resultSize` (see `src/edit/tool.ts`). `output.rs` gained `save_bytes` and `write_atomically`.

## [0.1.3] - 2026-11-07

### Changed
- **Image Viewer is now called Spektro Photo.** Your settings, recent folders and thumbnail cache carry over.
  - **Mac:** after installing, delete the old *Image Viewer* app from Applications.
  - **Windows (`-setup.exe`):** Spektro Photo installs next to the old app; uninstall *Image Viewer* from Settings → Apps. The `.msi` upgrades in place.

### Added
- **HEIC / HEIF photos on macOS** (iPhone photos): thumbnails, full-size viewing, zoom, camera details, crop and adjust.
  - Decoded in Rust by Apple's ImageIO framework, so rotation and wide-gamut colour (Display P3) are kept.
  - Edits are saved as a JPEG copy (`name (edited).jpg`), with camera data and colour profile kept. *Replace original* isn't available for HEIC.
  - HEIC files aren't listed on Windows.
- **Remove a folder from the recent list**, in the sidebar and on the welcome screen: click the × that appears on hover, or focus the folder and press <kbd>⌫</kbd>. Only the list entry goes; the folder isn't touched. An Undo toast puts it back.

### Developer
- `src-tauri/src/heic/`: `mod.rs` (format check, EXIF via kamadak-exif, any platform) and `imageio.rs` (macOS decoder through `objc2-image-io` / `objc2-core-graphics`).
- New `preview://` protocol (thumbs.rs) serves a full-size JPEG for formats the webview can't show, with the same folder checks and disk cache as `thumb://`.
- `imaging::open_scaled` decodes HEIC thumbnails directly at thumbnail size.
- HEIC test fixture in `src-tauri/test-data/`; decoder tests run on macOS only.

## [0.1.2] - 2026-11-01

### Added
- **Adjust colours.** Press <kbd>A</kbd> in the grid or viewer, click the new adjust button, or switch tabs inside the editor.
  - Temperature, brightness, contrast and saturation sliders (-100 to +100) in a side panel.
  - Live preview that matches the saved file, also shown while cropping, so a crop and an adjustment are saved together.
  - <kbd>Tab</kbd> between sliders, arrow keys to change one (<kbd>Shift</kbd>: 10), double-click to reset one, or *Reset all*.
- Editor shortcuts for switching tools (<kbd>C</kbd> / <kbd>A</kbd>) in the shortcuts sheet.

### Developer
- Colour-matrix pipeline in Rust (`edit/color.rs`) and TypeScript (`src/edit/colorMatrix.ts`), with one `Adjust` operation (`edit/adjust.rs`) mirrored by `tools/adjust/adjustments.ts`. A test pins the matrix both sides must produce.
- Tools can now provide a side `Panel` and a `colorMatrix` for live preview; `EditMode` can open on a given tool.
- 16-bit PNGs keep their bit depth when adjusted; greyscale images become RGB.

## [0.1.1] - 2026-10-26

### Added
- **Crop editor.** Open it with <kbd>C</kbd> or the crop button in the viewer.
  - Draggable crop box with corner and edge handles; drag outside the box to draw a new one.
  - Aspect presets: Free, Original, 1:1, 4:3, 3:2, 16:9, with a portrait / landscape switch.
  - Arrow keys nudge the box by 1 px (<kbd>Shift</kbd>: 10 px).
  - **Save as copy** (<kbd>⌘</kbd><kbd>S</kbd>) writes `name (edited).ext` beside the original, then `(edited 2)` and so on.
  - **Replace original** asks for confirmation, then moves the original to the Trash so it can be restored.
- Edited images keep their EXIF metadata (camera, lens, date taken…) and colour profile.
- Editor shortcuts in the keyboard shortcuts sheet (<kbd>?</kbd>).
- MIT license.

### Changed
- Photos stored sideways (EXIF orientation) are cropped as displayed, then saved upright with the orientation flag reset.
- Images and thumbnails reload automatically after a file is replaced by an edit.
- File modification times are tracked in milliseconds instead of seconds.
- Thumbnails and editing share one image loader in Rust.

### Developer
- New modular edit pipeline: an `Operation` trait and `EditOp` enum in Rust (`src-tauri/src/edit/`), and a tool registry in the frontend (`src/edit/`). The README's "Adding an edit tool" section explains how to add one.
- Rust unit tests for cropping, EXIF orientation, metadata preservation, file naming, and the save-as-copy and replace paths (`cargo test`).

### Known limitations
- Animated GIFs can't be edited (saving would keep only the first frame).
- JPEGs are re-encoded at quality 92; WebP is saved losslessly, so files may grow.

## [0.1.0] - 2026-10-23

First release.

### Added
- Open a folder or an image from the dialog, by drag and drop, or from recent folders.
- Thumbnail grid with adjustable size, filtering by name, and sorting by name, date or size. Thumbnails are generated in Rust and cached on disk.
- Viewer with zoom toward the cursor, panning, fit / 100%, view-only rotation, a navigator when zoomed in, and a filmstrip.
- Info panel with file details and camera EXIF.
- Move to Trash with a 5-second Undo.
- Keyboard shortcuts for everything, listed with <kbd>?</kbd>.
- Remembers window size, thumbnail size, sort order and recent folders.
- Installers for macOS (Apple Silicon, `.dmg`) and Windows (`.msi` and `-setup.exe`), built by GitHub Actions.

[Unreleased]: https://github.com/avirup171/spektro-photo/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/avirup171/spektro-photo/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/avirup171/spektro-photo/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/avirup171/spektro-photo/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/avirup171/spektro-photo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/avirup171/spektro-photo/releases/tag/v0.1.0
