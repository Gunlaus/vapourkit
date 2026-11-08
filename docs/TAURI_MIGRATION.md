# Vapourkit: Tauri 2 migration

Status: **Native processing preview; not a production Electron replacement.**

## What runs under Tauri

The separate React preview now uses a typed adapter in `src/native/host.ts` and Rust services for:

- Discovering FFmpeg, FFprobe, Python, and VSPipe in installed Vapourkit data and on PATH. Linux discovery includes `$XDG_CONFIG_HOME/vapourkit-gui/data` (or `~/.config/vapourkit-gui/data`) and wheel-installed `lib/python3.X/site-packages/vapoursynth/vspipe`.
- Inspecting media streams and selecting audio/subtitle stream indices. Video uses x264/x265 or an explicitly selected NVENC encoder; a fixed test-frame probe reports whether the encoder can actually initialize.
- Encoding a source video, or piping output 0 of a **trusted, existing `.vpy` script** through VSPipe's Matroska output into FFmpeg. Selected source audio/subtitles and metadata are muxed alongside rendered video. The script must preserve source timing; graphical chains, trim synchronization, and model management are not yet ported.
- Progress events, a reserved encoding slot, cancellation of FFmpeg and VSPipe, cleanup/reaping on failure, and bounded concurrent output capture. Linux workloads use independent process groups so helper processes cannot keep capture pipes open after timeout.
- Individual JPEG frame previews over binary IPC. Full-resolution frames are not serialized into JSON events. This is not the production streaming chain-preview protocol.
- Native input/script/output dialogs. Cancelling a dialog preserves the previous selection.
- A Rust-owned, sequential queue with per-job encoding-option snapshots and script paths, atomic persistence before state transitions, retry/remove/clear-finished, and applying encoding options to pending jobs. UI reloads resubscribe to the running queue. Stale snapshots cannot replace newer state. An interrupted job is marked failed on restart and never automatically rerun.
- Native encoding profiles and explicit default-encoder settings, saved atomically with synchronized files. Corrupt persisted JSON is reported and preserved instead of silently replaced. Windows replacement does not delete the previous document first.

Every encode writes to its own temporary file in the destination directory and publishes it using a no-clobber operation only after both processes succeed. Existing files, including files created while encoding, are preserved. Normal cancellation/failure removes the temporary file. An abrupt OS/process termination can leave an app-created hidden `.vapourkit-*` file; it is not treated as a completed output.

Closing the window is blocked while encoding or the queue is active, with a visible instruction to stop processing first. Forced application exit requests cancellation. Queue transitions already on disk recover conservatively on the next launch.

## Data compatibility and permissions

Production Electron configuration, queues, models, templates, workflows, and runtimes are not rewritten. Runtime discovery reads the existing data layout. Preview-owned settings, profiles, and queue remain isolated:

- Windows: `data/tauri-preview/` beside the native executable.
- Linux: `$XDG_CONFIG_HOME/vapourkit-tauri-preview/` or `~/.config/vapourkit-tauri-preview/`.

This isolation is deliberate until the production schemas and their migration tests are implemented. It is not a completed migration of Electron user data.

The frontend has no broad shell, filesystem, or process plugin permission. Rust exposes fixed commands, validates encoding options/paths/track selections, and never executes a shell. Native file dialogs use the Rust dialog plugin. Production CSP restricts scripts to packaged sources; development permits Vite's inline refresh preamble. Trusted VapourSynth scripts still execute Python and imports, as the UI explicitly states.

## Remaining production migration

`docs/TAURI_CONTRACT.json` inventories **135 Electron methods** and the native commands. Its `productionAdapter` entries are intentionally pending: preview building blocks have different contracts and must not be mistaken for a compatible `window.electronAPI` implementation. `npm run check:tauri-contract` checks the inventory and that every typed native invocation is registered in Rust.

| Area | Native preview | Work required before production replacement |
| --- | --- | --- |
| Main renderer/host adapter | Separate typed preview adapter | Port the production renderer's contracts, event payloads, errors, and host detection; mount the original UI only after parity |
| Runtime/setup | Existing-runtime discovery and import checks | Windows embedded Python/bootstrap, Linux venv setup, downloads, plugins, compatibility checks, repair/update/uninstall and cancellation |
| GPU/providers/models | Functional NVENC initialization probe; scripts may use installed runtimes | Backend detection, GPU statistics, ONNX validation/import/metadata/categories, TensorRT engine builds, NCNN/DirectML/MIGraphX setup and provider selection |
| Filters/workflows | Render existing trusted scripts | Port script generation/chain graphs, template catalog and validation/import/export/update reconciliation, workflow and LUT APIs, reference alignment and cancellation |
| Encoding | Fixed typed options, source track mapping and trusted-script pipeline | Production rate control/colorimetry/container controls, frame/trim/VFR synchronization, processing formats, benchmarking and complete encoder parity |
| Preview/media | Metadata, native pickers and binary still frames | File-drop path handling, secure video playback protocol, warm chain sessions, credit/backpressure streaming, comparison and external preview launch |
| Persistence | Durable native queue/profiles/settings | Import production schemas without data loss, portable Windows and Linux fixture tests, production queue adapter and shutdown semantics |
| Platform/integration | Tauri host build configuration and CSP | Production resource staging, branded installers/AppImage, update/log/report services, external URL/folder controls, Discord integration and other ancillary contracts |
| Validation | Core Rust/media tests and browser contract smoke | Windows/Linux webview runs, GPU workloads on supported hardware, all production renderer workflows, resource/migration/package tests and memory/performance comparison |

Do not remove Electron, enable production bundles, or mark the migration complete until these contracts and platform checks pass. `src/main.tsx` continues loading the Electron application under Electron and the separate preview under Tauri.

## Development and verification

Existing Electron commands remain supported:

```sh
npm ci
npm run build
npm test
npm run test:electron
```

For the native preview, install Rust plus the Tauri 2 prerequisites for the OS:

```sh
npm ci --ignore-scripts
npm run dev:tauri
npm run build:tauri -- -- --locked
```

The last command builds an experimental executable without production bundling. A committed Cargo lockfile and `npm ci` keep dependency resolution reproducible. CI runs Windows/Linux desktop compilation without repository write permission or automatic commits.

Rust services can be tested without GTK/WebKit:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --no-default-features --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
npm run check:tauri-contract
```

Real media integration tests create short videos and exercise selected audio, Unicode paths, binary previews, cancellation, late output conflicts, and actual VapourSynth rendering:

```sh
# FFmpeg must be on PATH. The script-render test additionally needs a configured
# VSPipe/VapourSynth R79 environment on PATH (python -m vapoursynth config).
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --test media_pipeline -- --ignored
```

Browser UI checks use a mocked Tauri transport to verify picker cancellation, script and track snapshots, applying options, stale events, stop/retry, running-state recovery on reload, and StrictMode listener cleanup. They do not replace native webview tests:

```sh
npx playwright install chromium
npm run test:tauri-ui
# Or use an existing Chromium:
# PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm run test:tauri-ui
```

The local validation environment can execute core Rust, actual FFmpeg/VapourSynth R79, TypeScript, and Chromium tests. It lacks GTK/WebKit development packages and an administrator installer, so local native-desktop compilation is unavailable; Windows/Linux desktop build results must come from CI. GPU inference and hardware compatibility are not established by CPU media tests.
