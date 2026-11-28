"""Dedicated HDRTVNet++ inference. RGB709 SDR -> RGB2020 PQ, never ITM twice."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ABI = 1


def engine_arguments(source, engine, shape, backend):
    def size(values): return 'input:' + 'x'.join(map(str, values))
    return ['--vkRuntime=' + backend, '--vkAdapter=rgb-window-v1',
            '--onnx=' + str(source), '--saveEngine=' + str(engine),
            '--minShapes=' + size([1, 3, 128, 128]),
            '--optShapes=' + size(shape), '--maxShapes=' + size(shape),
            '--builderOptimizationLevel=3', '--noTF32']


def load_model(clip, source, cache, backend, builder, streams=1, cuda_graph=True):
    import vapoursynth as vs
    import vk_model_runtime as common
    if backend not in ('tensorrt', 'tensorrt-rtx'):
        raise RuntimeError('HDRTVNet++ currently requires TensorRT or TensorRT-RTX inference. CPU video encoding is still supported.')
    if min(clip.width, clip.height) < 128:
        raise RuntimeError('HDRTVNet++ currently requires at least 128 pixels in both dimensions.')
    if backend == 'tensorrt-rtx':
        from vk_rtx_runtime import ensure_plugin
        ensure_plugin()
    shape = [1, 3, clip.height, clip.width]
    identity = common.runtime_identity(backend=backend)
    if backend == 'tensorrt-rtx': identity = common.canonical_rtx_identity(identity)
    contract = common.graph_contract(source)
    key = hashlib.sha256(json.dumps(dict(abi=ABI, source=contract, shape=shape,
        runtime=identity, backend=backend, precision='fp32-no-tf32'), sort_keys=True).encode()).hexdigest()
    folder = Path(cache) / backend
    folder.mkdir(parents=True, exist_ok=True)
    engine = folder / (key + '.engine')
    with common.engine_build_lock(str(engine) + '.hdr-loader'):
        manifest = common.engine_metadata(engine)
        recorded = manifest.get('runtime') if manifest else None
        if backend == 'tensorrt-rtx': recorded = common.canonical_rtx_identity(recorded)
        if not manifest or recorded != identity:
            print('[vk-hdr] Building a separate validated HDRTVNet++ FP32 engine.', file=sys.stderr, flush=True)
            subprocess.run([sys.executable, '-u', str(builder), *engine_arguments(source, engine, shape, backend)],
                check=True, timeout=1800, stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr)
            manifest = common.engine_metadata(engine)
            recorded = manifest.get('runtime') if manifest else None
            if backend == 'tensorrt-rtx': recorded = common.canonical_rtx_identity(recorded)
            if not manifest or recorded != identity:
                raise RuntimeError('HDRTVNet++ engine validation or runtime identity did not match. Keep the engine report when reporting this failure.')
        else:
            print('[vk-hdr] Reusing the validated HDRTVNet++ engine.', file=sys.stderr, flush=True)
    result = common.raw_model([clip], engine, streams, manifest['bindings'], cuda_graph, backend=backend)
    result = vs.core.resize.Point(result, format=vs.RGBS)
    return vs.core.std.SetFrameProps(result, _Matrix=0, _Primaries=9, _Transfer=16, _Range=1)
