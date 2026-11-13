# Pipeline reliability and measurement

VapourSynth remains pinned to R79. Its API3/API4 compatibility is retained. No core upgrade, automatic GPU scheduling change, or dependency upgrade is part of this change.

## Encoding reliability

A cold TensorRT build previously inherited the media producer's stdout. Builder progress could therefore precede Matroska's EBML header and make FFmpeg report `EBML header parsing failed`, followed by a stdin EOF. The runtime now sends builder stdout/stderr to descriptor 2, and the builder entry point also redirects native stdout. Generated Python scripts route `print()` to stderr without redirecting the media descriptor itself.

The Node handoff checks the initial Matroska header across chunk boundaries and keeps normal stream backpressure. It fails with an upstream diagnostic if stdout contains text or no header. It does not strip arbitrary bytes or attempt to repair corrupt media. Render completion requires both VapourSynth and FFmpeg to succeed, so an FFmpeg exit of zero cannot hide a late producer failure. Python traceback details take priority over a generic downstream input error.

This is a reproducible cause of the reported symptom, rather than proof of the precise source in a log that contains only FFmpeg's final error. CI exercises noisy cold-build output, real R79 frames, the Node relay, and FFmpeg decoding; GPU execution is stubbed in that transport test.

## Controls

Settings → Processing contains pipeline controls:

- Concurrent frame requests: automatic (the unchanged default), or a bounded vspipe request count. More requests may increase RAM/VRAM without improving throughput. The existing model inference-stream setting remains separate.
- Encoding preview height and frame rate: default 720 pixels and 1 fps. These affect only the JPEG preview output. Turning preview off before rendering removes that output branch.
- Keep RGB between adjacent AI models: experimental and off by default. Eligible adjacent AI stages avoid the intermediate RGB → YUV444P16 → RGB conversion. Custom filters, retained reference steps, and chain ends remain boundaries. Preview taps receive their own YUV view. Eliminating a conversion can change rounding and subsequent neural outputs; compare results before adopting it.

Saved controls apply to new validations/renders. Reopen an existing preview to apply them. No automatic tuner selects a winner from a different GPU or video.

## Repeatable benchmarks

Load a video and workflow, then select **Export current pipeline benchmark bundle** in Settings → Processing. A new directory contains `benchmark.json`, `source.vpy`, `workflow.vpy`, and `workflow-rgb.vpy`. It references your current installation, source and models; it does not copy those assets or change your workflow. Scripts can execute custom filter code exactly as a normal workflow does. Review paths before sharing a bundle/report.

Use a checkout of this branch, `npm ci`, `npm run build`, and Python 3.12. The app's private Python is suitable if its dependencies are installed. From the checkout, for example:

```sh
python scripts/benchmarkPipeline.py --bundle /path/to/benchmark.json --node node --frames 96 --runs 3 --requests 1,4 --threads 4 --output legacy.json
python scripts/benchmarkPipeline.py --bundle /path/to/benchmark.json --node node --variant rgb --frames 96 --runs 3 --requests 1,4 --threads 4 --output rgb.json
```

On Windows replace `python` with the full path to `data/vapoursynth-portable/python.exe` and quote paths containing spaces. Bundle vspipe/FFmpeg paths are used unless explicitly overridden. `--node` includes the actual Node/MatroskaPipe relay; omitting it measures a direct OS pipe and labels that limitation in the report.

The four stages are source evaluation (decode), full graph evaluation without media serialization (filter), encoding a fixed uncompressed snapshot (encode), and the full video pipeline through the Matroska pipe (combined). The filter stage includes decoding. Encoder-only includes reading/demuxing the warm snapshot. Do not subtract these parallel stage timings to invent isolated costs. The benchmark excludes audio/subtitle muxing and final container writes; it is not a full queue job timing.

Reports record bounded frame counts, per-run times, medians/FPS, actual core/thread/format metadata, encoder arguments, and Node producer/consumer status. Graph preparation and snapshot warmup are separate; each measured run still includes fresh process startup. Engine creation during graph preparation is excluded from measured medians. Compare cold-build/startup logs separately. Normal render logs now include time to first media bytes, first encoded progress, and total encode-run time.

Start with 48–120 frames. The default snapshot limit is 1 GiB and available disk is checked; lower `--frames` for high resolution/RGB float clips. `--max-cache-mib` raises the explicit budget. `--streams 1,2` sweeps managed TensorRT calls in benchmark copies only; unsupported scripts fail rather than silently ignore it. `--requests`, `--threads`, and `--streams` combinations are limited to 32. `--preview` adds the encoding preview branch; compare the same workflow with it off/on. Use `--preview-height` and `--preview-fps` to explore its cost.

Exported encoder arguments are used, with source metadata/audio/subtitle mappings omitted and listed in the report. Advanced extra inputs/complex filter graphs require a video-only `--encoder-args` JSON array. For a CPU baseline, use `--encoder-args '["-c:v","libx264","-preset","veryfast","-crf","18","-threads","4"]'` (adjust shell quoting on Windows). Keep encoder, preview, source, frame range, cache state and hardware identical between comparisons. Rerun close/noisy results, then verify output quality and memory use on real models before changing production settings.

## Development measurement (CPU fixture, not a GPU promise)

An R79/BestSource fixture used 96 frames of 1280×720 `testsrc2`, two RGB floating-point clamp operations, four VS threads, libx264 veryfast/CRF18/four encoder threads, the Node relay, and three measured samples. The legacy script inserted a YUV444P16 roundtrip between the clamps; the RGB script retained RGB. Median wall times in milliseconds:

| Layout | Requests | Decode | Filter | Encode | Combined |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy | 1 | 368.7 | 968.3 | 597.2 | 1506.7 |
| Legacy | 4 | 318.7 | 795.4 | 579.2 | 1413.4 |
| RGB | 1 | 315.2 | 718.3 | 626.2 | 1306.1 |
| RGB | 4 | 315.0 | 599.5 | 570.9 | 1272.7 |

At four requests this fixture reduced measured filter time by about 25% and combined time by about 10%. A shorter 360p fixture gave mixed results, reinforcing the need for measurement. These are CPU conversion measurements, not measured TensorRT speedups. A first-frame 8-bit YUV comparison differed by at most one code value in this fixture; this does not bound differences after arbitrary neural models. RGB chaining therefore remains opt-in. No physical GPU throughput claim has been established.
