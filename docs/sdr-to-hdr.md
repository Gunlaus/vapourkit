# SDR-to-HDR implementation and evaluation

## Current stage: experimental deterministic baseline

The right-column SDR → HDR section is disabled by default. Its settings travel
inside workflow colorimetry, including queue snapshots and TOML exports.
Natural and Animation are starting expansion strengths, not validated grades.
Target peak is an upper bound, not measured MaxCLL or display mastering metadata.

The managed pipeline is:

1. Inspect the source before legacy metadata overrides. Reject PQ/HLG and
   interlaced input. Resolve supported SDR tags, using existing source defaults
   when unspecified. Inputs with unsupported color tags stop explicitly.
2. For subsampled YUV, automatically reconstruct chroma to YUV444P16 with
   Spline36, honoring chroma location (left if missing). Full-chroma inputs skip
   this operation. Turning the option off retains normal downstream sampling.
3. Run the ordinary SDR filter chain. SDR models and GLSL shaders stay before HDR.
4. Convert to linear BT.2020 RGB float, expand luminance using a shared RGB gain,
   bound channels to the target peak, and encode PQ. Quantize/dither to limited
   YUV420P10 once at the final HDR output stage.
5. Encode HEVC/AV1 with matching PQ/BT.2020 tags. Simple incompatible codecs
   switch to HEVC when enabling HDR; conflicting Advanced video arguments stop
   the job. A failed HDR policy never falls back to SDR encoder defaults.
6. Probe the completed file before reporting success. Require HEVC/AV1,
   yuv420p10le, limited range, PQ and BT.2020 tags. Keep rejected files for inspection.

For normalized linear luminance Y, the reference curve is:

    L = reference_white * Y + (target_peak - reference_white) * strength * Y**5

Values are in nits. At zero strength SDR white maps to reference white; at full
strength it reaches target peak. Midtones change less than highlights. A common
gain preserves RGB ratios, subject to input gamut clipping and the peak bound.
The curve has no per-frame adaptation, so it adds no exposure pumping. It does
not identify specular highlights, recover clipped detail or protect baked-in
subtitle whites semantically. Reference white is the baseline scale, not a
guarantee that every diffuse white stays at that luminance after expansion.

While HDR is active, Source color replaces the combined legacy override with
independent input matrix, primaries, transfer and range controls. Auto honors
source tags; missing values use the existing SDR defaults. The resolved values
are logged with `[hdr-source]`. The legacy combined override is bypassed so it
cannot overwrite these decisions.

The first path uses VapourSynth with existing CPU/NVIDIA/AMD/Intel encoding
options. NVEncC's shader bypass is disabled for HDR so it cannot omit conversion.
No mastering-display or content-light values are fabricated from the peak slider.
Do not describe this as a fully mastered HDR10 release yet.

Both previews are SDR representations: the dedicated preview has a named HDR
result tab with explicit tone mapping; the encoding JPEG branch is tone-mapped
separately and does not change the main encode. Neither certifies HDR appearance.
The generated copy replaces only the standard template's final conversion;
the saved user template is never overwritten. Unknown layouts stop with guidance.

## Next comparison stage

Evaluate the complete pretrained HDRTVNet++ pipeline, including its color-domain
contract, against this baseline. Do not run an HDR model through the generic RGB
upscaler adapter. Check code and checkpoint distribution terms independently.

Compare conventional chroma reconstruction with KrigBilateral and ArtCNN Chroma.
ArtCNN's documented training domain is 4:2:0 BT.709 with bilinear preprocessing;
do not apply it blindly to BT.601, 4:2:2 or HDR input.

Add shot analysis and temporal adaptation only after evaluating brightness
pumping, cut resets and random-access preview reproducibility. Keep generative
diffusion conversion separate from the faithful default.

## Quality gate before a default or build

- Run the generated graph on the target VapourSynth/zimg runtime and NVIDIA GPU.
- Compare black, neutral ramps, color patches and known PQ luminances numerically.
- Evaluate anime, live action, faces, saturated colors, credits, white subtitles,
  grain, dark scenes, clipped lights, rapid cuts and slow fades on an HDR display.
- Match reference white and target peak for libplacebo/RTX HDR comparisons.
- Verify GPU encoding, preview parity, queue persistence and metadata in MPV.
- Measure final content-light statistics before adding optional MaxCLL/MaxFALL.

The current CPU tests cover curve bounds/monotonicity, workflow round trips,
generation order, fail-closed encoder policy, and real FFmpeg PQ/10-bit output
verification with identical decoded video when the SDR preview is enabled.
They do not establish superiority over real-time converters.


## HDRTVNet++ comparison build

The optional Method selector now offers the exported AGCM+LE ensemble. It uses
NVIDIA TensorRT/TensorRT-RTX inference (CPU video encoding remains available),
one inference stream, and a separate validated FP32/no-TF32 engine cache. The
first use builds an engine; subsequent uses of the same size/runtime reuse it.
All model resources and their provenance are bundled, verified, and copied to a
content-addressed private folder. Failure does not silently substitute the
mathematical method.

Canonical SDR BT.709 RGB enters the network. Its output is already BT.2020 PQ,
so only an HDR exposure trim and target-peak shoulder are applied afterward.
Mathematical Look, highlight strength and reference-white controls are hidden
for this method; Exposure (stops) and target peak control the model's grade.
No second inverse tone map, highlight hallucination, tiling, or temporal
smoothing is applied. Start tests with a short 1080p HDR-only job and zero
exposure trim, then compare the mathematical method on the same source.
