# Video GIF Studio

Offline Windows/macOS desktop app for evaluating and converting MP4 videos to GIFs. It uses Tauri, a vanilla HTML/CSS/JS interface, and local FFmpeg/ffprobe processes. No account or server is used.

## Use

1. Add MP4 files or choose a folder. Folder selection reads MP4 files directly inside that folder.
2. Set FPS, maximum GIF size, output dimensions, colors, aspect ratio, optional crop, and clip start/duration. Duration `0` means the rest of each video.
3. Choose **Adjust to fit** or **Keep my settings**. **Skip GIFs above the size limit** is on by default.
4. Click **Evaluate sizes**. This performs real temporary encodes, so the resulting sizes are measured, not guessed. A file counter and progress bar show evaluation progress. Long clips can take considerably longer than a few minutes.
5. Review the green/red statuses and adjusted settings. Click **Save GIFs** to copy qualifying evaluated files into the output folder. The default folder is next to the selected video/folder and is named `video-gif-[fps]fps-[duration]s`.

Changing an encoding setting clears evaluation results. GIFs that remain above the limit after adjustment are shown as above limit and skipped by default. Cancellation takes effect after the current FFmpeg encode finishes.

## Requirements

- Windows 10/11 or a recent macOS version
- Node.js 20+, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for building
- FFmpeg and ffprobe accessible on `PATH` **on the build computer**. The build script copies them into the installer, so recipients do not install them separately.

Install FFmpeg on the build computer with `winget install Gyan.FFmpeg` on Windows or supply an appropriate self-contained macOS build. Set `FFMPEG_BIN_DIR` to the folder containing `ffmpeg` and `ffprobe` if they are not on `PATH`. A Homebrew FFmpeg binary can depend on Homebrew libraries and may not work when copied alone to another Mac; use a redistributable self-contained build or bundle its required libraries. The build script copies any `LICENSE` and `README.txt` found at the FFmpeg package root into the app resources. Review the exact build's license and provide its corresponding source when distributing it.

## Develop and build

```sh
npm install
npm run tauri dev
npm run tauri build
```

Build Windows installers on Windows and macOS app bundles on a Mac. Output appears in `src-tauri/target/release/bundle/`. A developer account is not needed to build or run locally. Unsigned Windows downloads may show a SmartScreen warning. For macOS sharing outside a trusted development team, signing and notarization with an Apple Developer ID is the reliable distribution route; unsigned downloads require manual Gatekeeper approval and may be disallowed by company policy.

### Build a macOS DMG

On a Mac, install Xcode Command Line Tools (`xcode-select --install`), Node.js 20+, and Rust (`rustup`). Obtain a **self-contained** macOS build of both `ffmpeg` and `ffprobe` for that Mac's CPU architecture. The build script rejects binaries linked to libraries outside macOS system directories, since copying a Homebrew FFmpeg executable alone would leave those libraries behind.

```sh
cd /path/to/video-to-gif
npm install
export FFMPEG_BIN_DIR=/path/to/self-contained-ffmpeg/bin
npm run tauri dev
npm run tauri build -- --bundles dmg
```

The output is under `src-tauri/target/release/bundle/dmg/`. The build includes both FFmpeg tools, so recipients do not install them. Test the DMG on a separate Mac, including adding a video and saving a GIF. The DMG built without a Developer ID is unsigned; Gatekeeper can block it when downloaded by teammates. To distribute broadly, sign and notarize the app with an Apple Developer Program account. Check FFmpeg license and corresponding-source requirements for the exact binary build included.

## Current limits

- MP4 files only; one folder level.
- Batch-wide clip and crop settings. Per-video settings are planned but not implemented.
- Evaluation runs sequentially and its progress shows completed files; it does not show frame-level percentage within the current file.
- A temporary evaluated GIF is reused for saving during the current app session. Temporary files are kept in the OS temp directory for that session.
- macOS packaging and Gatekeeper behavior have not been tested in this Windows workspace.

The app uses FFmpeg's generated palette and palette application filters. See [FFmpeg's license information](https://www.ffmpeg.org/legal.html) before redistributing FFmpeg with the app.
