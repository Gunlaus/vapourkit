# Vapourkit: Tauri 2 migration

Status: **Foundation only. Not a functional Electron replacement.**

## Guardrails

- Keep the existing Electron application runnable until all production IPC endpoints have been migrated and tested.
- Preserve the React UI, VapourSynth/Python runtime, FFmpeg pipeline, models, user settings, queues, templates, and workflows.
- Do not silently change the portable Windows data directory or Linux XDG-backed storage.
- Do not label the migration complete merely because the Tauri window starts.
- Do not enable broad filesystem, shell, or process permissions in the frontend. Rust must validate all privileged operations.

## Current baseline

- React + Vite renderer in `src/`.
- Electron main process and IPC handlers in `electron/`.
- Electron preload exposes a large `window.electronAPI` surface, including synchronous queue persistence and transferable preview ports.
- FFmpeg, VapourSynth, Python, CUDA and model operations are external native processes or runtimes. They remain separate from the UI host.
- The existing `npm run dev`, `npm run build` and Electron packaging scripts remain the supported path.

## Migration stages

1. **Foundation**: minimal Tauri 2 host and independent dev/build scripts; retain Electron unchanged.
2. **Contract inventory**: map each preload method and event to a typed command/event contract, including error semantics, cancellation, and streaming previews.
3. **Rust services**: introduce config/data migration, diagnostics, process supervision, FFmpeg/VapourSynth discovery, hardware probes, and validated command execution. Test each service before wiring it to the UI.
4. **Renderer adapter**: introduce a typed host interface; switch feature groups to Tauri only after matching Electron behavior. Do not make the UI depend on two incompatible globals.
5. **Critical fixes**: NVENC detection/errors, imported filter validation, filter-picker cancellation, richer encoding controls, preview toggle, batch apply, and track selection.
6. **Stabilization**: Windows and Linux CI builds, packaging and runtime resource validation, migration tests, hardware smoke tests, and removal of Electron only after parity.

## Important technical risks

- `webUtils.getPathForFile` and Electron's custom `video://` protocol need secure Tauri equivalents.
- Electron `MessagePort`-based preview playback needs a measured replacement; do not send full-resolution frames through JSON events.
- `ipcRenderer.sendSync` queue persistence must be replaced with a durable async design and flush-on-shutdown strategy.
- Existing portable Windows user data must remain discoverable after migration.
- Linux AppImage and native dependencies need separate integration tests.
- Tauri uses the OS webview; memory and rendering behavior must be benchmarked, not assumed.

## Developer commands (foundation)

Install Rust and Tauri 2 prerequisites for the target OS, then run:

```sh
npm install
npm run dev:tauri
```

`npm run build:tauri` builds the experimental host but **does not create production bundles**. The current React UI still calls `window.electronAPI`, so it is not yet operational under Tauri. Use Electron for normal Vapourkit use.

## Verification status

The GitHub connector can edit repository files but cannot execute local Rust builds, VapourSynth workloads, or GPU tests. No compilation or runtime verification has been performed for this initial scaffold.
