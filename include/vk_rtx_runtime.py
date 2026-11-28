"""Optional TensorRT-RTX backend. Private, validated caches; no classic engine reuse."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import vk_model_runtime as common

CACHE_ABI = 1
_DLL_HANDLES = []


def ensure_plugin():
    """Import SDK DLLs before retrying a plugin whose early autoload failed."""
    try:
        common.tensor_module('tensorrt-rtx')
        import vapoursynth as vs
        if not hasattr(vs.core, 'trt_rtx'):
            import tensorrt_rtx_libs
            import os
            roots = list(getattr(tensorrt_rtx_libs, '__path__', []))
            if os.name == 'nt':
                for root in roots:
                    _DLL_HANDLES.append(os.add_dll_directory(str(root)))
            filename = 'vstrt_rtx.dll' if os.name == 'nt' else 'libvstrt_rtx.so'
            plugin = Path(vs.__file__).parent / 'plugins' / 'trt_rtx' / filename
            vs.core.std.LoadPlugin(str(plugin))
        return vs.core.trt_rtx.Version()
    except (ImportError, OSError, AttributeError) as error:
        raise RuntimeError('Install the optional TensorRT-RTX backend in Settings → Processing first. ' + str(error)) from error


def cache_key(contract, shape, precision, identity):
    value = {'abi': CACHE_ABI, 'spatialAbi': common.ENGINE_ABI, 'source': contract,
             'shape': list(shape), 'precision': precision, 'runtime': common.canonical_rtx_identity(identity)}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def build_arguments(source, engine, contract, shape, precision):
    declared = contract['inputs'][0]['shape']
    smallest = [value if isinstance(value, int) and value > 0 else min(actual, 240)
                for value, actual in zip(declared, shape)]
    name = contract['inputs'][0]['name']
    def dims(values): return name + ':' + 'x'.join(map(str, values))
    args = ['--vkRuntime=tensorrt-rtx', '--vkAdapter=' + common.ADAPTER,
            '--onnx=' + str(source), '--saveEngine=' + str(engine),
            '--minShapes=' + dims(smallest), '--optShapes=' + dims(shape),
            '--maxShapes=' + dims(shape), '--builderOptimizationLevel=3']
    if precision == 'fp16': args.append('--fp16')
    return args


def metadata_rejection(metadata, identity):
    if not metadata:
        return 'The engine or its manifest is missing, unreadable, or failed its integrity check.'
    actual = common.canonical_rtx_identity(metadata.get('runtime'))
    expected = common.canonical_rtx_identity(identity)
    if actual == expected: return None
    def differences(left, right, prefix='runtime'):
        if isinstance(left, dict) and isinstance(right, dict):
            result = []
            for key in sorted(set(left) | set(right)):
                result.extend(differences(left.get(key), right.get(key), prefix + '.' + key))
            return result
        return [] if left == right else [prefix]
    return 'Runtime identity differs in: ' + ', '.join(differences(actual, expected)) + '.'


def load_model(clips, source, streams, precision, builder, python, cache, use_cuda_graph=True):
    if precision not in ('fp16', 'fp32'): raise ValueError('TensorRT-RTX supports FP16 or FP32 in this integration.')
    ensure_plugin()
    clips = clips if isinstance(clips, list) else [clips]
    contract = common.graph_contract(source)
    binding = contract['inputs'][0]
    expected_frames = binding['shape'][1] // 3
    if len(clips) != expected_frames:
        # A raw model selected through an inherited filter may carry an old
        # temporal setting. Follow the actual ONNX RGB contract.
        clips = common.temporal_window(clips[len(clips) // 2], expected_frames)
    height, width = clips[0].height, clips[0].width
    if any(c.height != height or c.width != width for c in clips):
        raise RuntimeError('TensorRT-RTX temporal inputs must have identical dimensions.')
    shape = [1, expected_frames * 3, height, width]
    for declared, actual in zip(binding['shape'], shape):
        if isinstance(declared, int) and declared > 0 and declared != actual:
            raise RuntimeError(f'The model requires fixed input {binding["shape"]}; this stage is {shape}. Use a dynamic ONNX export.')
    identity = common.runtime_identity(backend='tensorrt-rtx')
    folder = Path(cache)
    folder.mkdir(parents=True, exist_ok=True)
    engine = folder / (cache_key(contract, shape, precision, identity) + '.engine')
    # Separate from the child builder's engine lock: never wait on ourselves.
    with common.engine_build_lock(str(engine) + '.loader'):
        metadata = common.engine_metadata(engine)
        rejection = metadata_rejection(metadata, identity)
        if rejection:
            if not Path(builder).is_file(): raise RuntimeError('The bundled engine builder is missing. Extract a complete Vapourkit build.')
            print('[vk-rtx] Building a separate validated RTX engine for this model and input size.', file=sys.stderr, flush=True)
            args = [str(python), '-u', str(builder), *build_arguments(source, engine, contract, shape, precision)]
            # vspipe stdout is a media pipe. All child diagnostics go to stderr.
            subprocess.run(args, check=True, timeout=1800, stdin=subprocess.DEVNULL,
                           stdout=sys.stderr, stderr=sys.stderr)
            metadata = common.engine_metadata(engine)
            rejection = metadata_rejection(metadata, identity)
            if rejection:
                raise RuntimeError('The RTX builder completed, but the loader rejected its engine. ' + rejection +
                                   ' Keep the engine .json and .validation-report.json files when reporting this error.')
        else:
            print('[vk-rtx] Reusing validated engine: ' + engine.name, file=sys.stderr, flush=True)
    return common.raw_model(clips, engine, streams, metadata['bindings'], use_cuda_graph, backend='tensorrt-rtx')
