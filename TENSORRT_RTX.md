# Optional TensorRT-RTX experiment

Windows x64 can install TensorRT-RTX 1.7.1.116 and the matching vs-mlrt RTX
plugin 17.1 from **Settings → Processing → Install optional TensorRT-RTX backend**.
The private Python environment must already have the regular NVIDIA plugin
bundle installed. The optional install pins its four wheels without dependency
resolution, preserving the current VapourSynth and classic TensorRT packages.
It checks SDK/plugin loading before marking the addition ready.

Keep **Execution backend: VapourSynth**, then select **TensorRT-RTX
(experimental)** as the inference backend, globally or per AI model. Existing
classic engines are resolved back to their original ONNX; they cannot be loaded
by RTX. Select a model's intended precision as usual. FP16 exports are not
promoted into purported FP32 models, and FP32 exports are only converted when
FP16 was requested. BF16 is outside this experiment.

Image models and supported odd channel-packed RGB temporal windows use the
shared ONNX spatial contract, padding discovery and private pad/crop adapter.
Models with other tensor contracts still need their own adapters. VS script
filters continue to use the regular TensorRT backend; this addition changes the
main AI-model inference calls only. It does not replace VapourSynth or change
its API compatibility. NVEncC execution keeps its existing runtime and restrictions.

The first use at an input resolution builds a private RTX engine in
`data/tensorrt-rtx/engines`. Cache identity includes source and external weights,
precision, input shape, SDK/plugin, selected GPU and driver. Original models and
classic engines remain untouched. The shared builder must pass actual
VapourSynth execution at profile endpoints and the existing CPU numerical
reference check before publishing a usable engine. Its child output is routed
to stderr to preserve vspipe's media pipe. Repeating the same stage reuses the
validated engine, with `[vk-rtx] Reusing validated engine` in the log. Runtime/JIT
initialization can still occur when a new process loads that engine.

For a useful comparison, run the same full clip with classic TensorRT and RTX,
with identical model, precision, streams, frames in flight, preview state and
encoder settings. Warm up both first. Compare completed pipeline summaries,
not the first compilation run. Check the output for visual changes and test
subsequent validation, preview and queue starts for cache reuse.

RTX is an alternative runtime to measure, not a promised throughput upgrade.
NVIDIA's [porting guide](https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/inference-library/porting.html)
describes deployment/JIT benefits and notes classic TensorRT can offer higher
throughput on a fixed GPU. Its [CPU-only AOT support](https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/inference-library/cpu-engines.html)
allows real parsing/compilation checks without a GPU; those checks do not
establish GPU execution accuracy or speed. Keep classic TensorRT selected if
RTX is slower or unsupported by a particular model.
