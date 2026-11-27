# GLSL shaders in NVEncC

Use **Add filter → GLSL Shader** for the bundled Anime4K CNN 2× Small, Medium
and Large presets, or import an mpv/libplacebo `.glsl` hook shader. Imports are
copied to a private content-addressed cache, leaving the original file intact.
Closing the picker before selecting a shader adds no chain step.

Choose **Settings → Processing → Execution backend: NVEncC GPU**, install or
repair that optional backend if necessary, and use **Simple NVIDIA** H.264,
HEVC or AV1 encoding. The inference selector does not affect shader-only runs:
no ONNX model or TensorRT engine is required. GPU rendering uses NVEncC 9.41's
libplacebo integration and its packaged `libplacebo-360.dll`.

This first version accepts **one main-chain shader**, including multiple
internal shader passes. AI-plus-shader chains, VS filters, side chains,
segments, and benchmark-to-null mode are rejected with an explanation. Input
is full, progressive, limited-range BT.709 SDR YUV420 in 8 or 10 bits, as in the
existing native path. Output remains YUV420 at the selected 8/10-bit depth;
MKV retains selected subtitles and their attachments. The encoded video is
checked for dimensions, codec, bit depth, frame count where known and selected
tracks before the temporary output is published.

The built-in presets use 2× output. Custom shaders offer 1×, 2×, 3× or 4× output;
choose the size the shader is designed for. Resolution-dependent `//!WHEN`
clauses may intentionally skip passes at other sizes. Declared scalar
`//!PARAM` controls appear on the card, including numeric, integer, boolean
DEFINE (0/1), and ENUM choices. Imports accept the libplacebo parameter-body
syntax; the UI does not execute shader code or evaluate arbitrary expressions.
Generic GLSL programs and HLSL files need conversion to mpv hook syntax first.

Queue, session, undo/redo and workflow settings carry the shader selection,
scale and controls. Built-ins resolve by stable preset id after moving a
workflow between installs. Custom workflow paths refer to the imported local
copy; import the original shader again when moving to another machine.

**Preview and Validate through VapourSynth do not run shaders yet.** The app
reports that restriction instead of silently skipping the step. Start with a
short source clip, inspect the encoded output, then compare the native
`pipeline-summary` for longer runs. Shader summaries identify `processing:
"shader"`; the ONNX tensor-sharing metric is not used for shader renders.

The intended hardware path is GPU decoding → libplacebo shader rendering →
NVENC. CUDA/rendering interoperability still performs GPU copies and
synchronization. This feature does not claim zero copies or guaranteed speed
or quality relative to TensorRT-RTX. Windows/NVIDIA hardware tests remain
necessary beyond the mocked lifecycle and command tests.
