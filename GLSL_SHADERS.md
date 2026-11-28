# Shader library and automatic processing

**Add filter → GLSL Shader** opens the searchable, categorized shader library.
The defaults cover anime upscaling/restoration/denoising, RAVU general-image
upscaling for live-action comparisons, and SDR color, sharpening and effects.
Source versions and licenses are in `include/shaders/SOURCES.md`.

**Add GLSL shader** imports an mpv/libplacebo `.glsl` or `.hook` file into an
editor for its name, optional description, categories, default scale and source
code. Saving creates an internal Vapourkit copy. Closing before saving creates
no library entry or chain step. Library edits affect future selections;
existing selected snapshots remain reproducible until selected again.

Stack shader steps in the desired order. Standard processing uses the
`vs-placebo` plugin with the existing VapourSynth core and selected encoder,
including CPU encoders. It supports preview, benchmark, segments, AI models
and VS filters in the same chain. Install shader support from the library when
needed; it pins `vs-placebo==2.0.5` without upgrading core/dependencies.
The Windows plugin requests API4.0, compatible with pinned R79 and API3 filters.
CPU encoding still uses the GPU to execute GLSL.

There is no manual execution-backend setting. Compatible full shader-only
Windows NVIDIA encodes use the existing NVEncC runtime automatically when
installed, with one libplacebo stage per shader in chain order. Mixed chains,
CPU encoding, advanced output options, benchmarks and segments stay on the
standard pipeline. AI model inference always uses the selected standard
inference backend, including TensorRT-RTX. Native execution retains its existing
SDR/YUV420 source and container constraints. Optional native acceleration can
be installed from the shader library; it is not required for CPU encoding.

Declared scalar parameters are exposed on each card. Standard processing
bakes selected parameter values into private shaders; ENUM aliases retain their
original meanings. Native processing uses libplacebo's runtime parameter API.
Shader GPU compilation and speed require physical GPU testing beyond CI.

The console has a clear-view button and opens at the latest result. Clearing
uses a byte cursor, leaving the diagnostic log file intact. New output follows
the bottom while the user is there; scrolling back pauses following until the
bottom is reached or the console is reopened.
