"""Model/engine helpers shared by the engine builder and VapourSynth scripts.

The build dialog builds one engine per model, normally with a dynamic shape
profile. Scripts only load that engine; they never build one.
No third-party Python adapters or native plugins are downloaded by this module.
"""
import ctypes
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

SCHEMA = 1
ADAPTER = 'rgb-window-v1'
# Bump when learned build fallbacks become incompatible with this adapter.
ENGINE_ABI = 1
_IDENTITY = None


@contextmanager
def engine_build_lock(engine, timeout=1800):
    """Serialize builds of one engine across processes; the OS releases locks on exit."""
    with open(str(engine) + '.prepare.lock', 'a+b') as stream:
        stream.seek(0, 2)
        if stream.tell() == 0: stream.write(b'\0'); stream.flush()
        deadline = time.monotonic() + timeout
        waiting = False
        while True:
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK): raise
                if not waiting:
                    print('[vk-cache] Waiting for another process to prepare ' + Path(engine).name, file=sys.stderr, flush=True)
                    waiting = True
                if time.monotonic() >= deadline: raise RuntimeError('Timed out waiting for model preparation. Check the other preview/build task.') from error
                time.sleep(0.1)
        try: yield
        finally:
            stream.seek(0)
            if os.name == 'nt': msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else: fcntl.flock(stream, fcntl.LOCK_UN)


def temporal_window(clip, frames):
    if not isinstance(frames, int) or frames < 1 or frames % 2 == 0:
        raise RuntimeError('Centered temporal windows require a positive odd frame count.')
    result = []
    for offset in range(-(frames // 2), frames // 2 + 1):
        if offset < 0:
            count = min(-offset, clip.num_frames)
            shifted = clip[0] * count if count == clip.num_frames else clip[0] * count + clip[:-count]
        elif offset > 0:
            count = min(offset, clip.num_frames)
            shifted = clip[-1] * count if count == clip.num_frames else clip[count:] + clip[-1] * count
        else: shifted = clip
        result.append(shifted)
    return result


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def inspect_bindings(source):
    """Resolve exported symbols without rewriting the source model/weights."""
    import onnx
    model = onnx.load(str(source), load_external_data=False)
    def bindings(graph):
        initializers = {tensor.name for tensor in graph.initializer}
        def binding(item):
            value = item.type.tensor_type
            return {'name': item.name, 'dtype': int(value.elem_type),
                    'shape': [int(d.dim_value) if d.HasField('dim_value') else d.dim_param or None for d in value.shape.dim]}
        return ([binding(item) for item in graph.input if item.name not in initializers],
                [binding(item) for item in graph.output])
    ins, outs = bindings(model.graph)
    if any(len(item['shape']) == 4 and not isinstance(item['shape'][1], int) for item in ins + outs):
        try:
            inferred = onnx.shape_inference.infer_shapes(model, check_type=True, strict_mode=False, data_prop=True)
            ins, outs = bindings(inferred.graph)
        except Exception as error:
            raise RuntimeError('Could not resolve ONNX tensor channels using shape inference: ' + str(error)) from error
    return model, ins, outs


def file_stamp(file):
    stat = Path(file).stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino, stat.st_dev]


def cached_digest(file):
    """Reuse integrity checks only while the engine's filesystem identity is unchanged."""
    cache = Path(str(file) + '.vk-integrity.json')
    before = file_stamp(file)
    try:
        saved = json.loads(cache.read_text())
        if saved.get('stamp') == before and isinstance(saved.get('sha256'), str) and len(saved['sha256']) == 64:
            return saved['sha256']
    except (OSError, ValueError, TypeError, AttributeError): pass
    value = digest(file)
    if file_stamp(file) == before:
        stage = Path(str(cache) + '.' + str(os.getpid()) + '.tmp')
        try:
            stage.write_text(json.dumps({'stamp': before, 'sha256': value}))
            os.replace(stage, cache)
        except OSError: pass
        finally:
            try: stage.unlink(missing_ok=True)
            except OSError: pass
    return value


def graph_contract(source):
    import onnx
    model, ins, outs = inspect_bindings(source)
    if len(ins) != 1 or len(outs) != 1 or any(len(item['shape']) != 4 for item in ins + outs):
        raise RuntimeError('This model needs a dedicated tensor-layout adapter; automatic RGB setup supports one NCHW input and output.')
    channels = ins[0]['shape'][1]
    if not isinstance(channels, int):
        raise RuntimeError(f"Input {ins[0]['name']!r} channel dimension is unresolved after ONNX shape inference: {channels!r}. Re-export with a fixed RGB channel count or use a dedicated adapter.")
    if channels < 3 or channels % 3 or (channels // 3) % 2 == 0:
        raise RuntimeError(f"Unsupported RGB temporal layout: input {ins[0]['name']!r} has shape {ins[0]['shape']}. Use an image model or an odd channel-packed RGB window.")
    output_channels = outs[0]['shape'][1]
    if output_channels != 3:
        reason = 'unresolved after ONNX shape inference' if not isinstance(output_channels, int) else 'incompatible with RGB'
        raise RuntimeError(f"Output {outs[0]['name']!r} channel dimension is {reason}: {output_channels!r}; shape {outs[0]['shape']}. The RGB adapter requires three output channels.")
    if any(item['dtype'] not in (1, 10, 16) for item in ins + outs):
        raise RuntimeError('The RGB adapter supports FP32/FP16/BF16 image tensors only.')
    external = set()
    def tensor_files(tensor):
        for item in tensor.external_data:
            if item.key == 'location': external.add(item.value)
    def visit(graph):
        for tensor in graph.initializer: tensor_files(tensor)
        for sparse in graph.sparse_initializer: tensor_files(sparse.values)
        for node in graph.node:
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.TENSOR: tensor_files(attr.t)
                for tensor in attr.tensors: tensor_files(tensor)
                if attr.type == onnx.AttributeProto.GRAPH: visit(attr.g)
                for child in attr.graphs: visit(child)
    visit(model.graph)
    root = Path(source).resolve().parent
    files = [{'path': str(Path(source).resolve()), 'sha256': digest(source)}]
    for relative in sorted(external):
        file = (root / relative).resolve()
        if not relative or Path(relative).is_absolute() or root not in file.parents or not file.is_file():
            raise RuntimeError('Missing or invalid external weights: ' + relative)
        files.append({'path': str(file), 'sha256': digest(file)})
    metadata_path = Path(str(source) + '.contract.json')
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    multiple = metadata.get('spatialMultiple', 1)
    if not isinstance(multiple, int) or not 1 <= multiple <= 256: raise RuntimeError('Invalid model spatial multiple.')
    return {'schema': SCHEMA, 'adapter': ADAPTER, 'descriptor': metadata, 'spatialMultiple': multiple, 'inputs': ins, 'outputs': outs, 'files': files,
            'weightTypes': sorted(set(int(t.data_type) for t in model.graph.initializer))}


def runtime_identity():
    global _IDENTITY
    if _IDENTITY is not None: return _IDENTITY
    import tensorrt as trt
    import vapoursynth as vs
    driver = ctypes.CDLL('nvcuda.dll' if os.name == 'nt' else 'libcuda.so.1')
    def checked(code):
        if code: raise RuntimeError('CUDA device inspection failed: ' + str(code))
    checked(driver.cuInit(0))
    device = ctypes.c_int()
    # CUDA_VISIBLE_DEVICES remaps either numeric or UUID masks to visible
    # ordinals. No current context is required for cuDeviceGet.
    checked(driver.cuDeviceGet(ctypes.byref(device), 0))
    uuid = (ctypes.c_ubyte * 16)()
    checked(driver.cuDeviceGetUuid(ctypes.byref(uuid), device))
    version = ctypes.c_int(); checked(driver.cuDriverGetVersion(ctypes.byref(version)))
    import importlib.metadata
    packages = {}
    for package in ('nvidia-modelopt', 'onnx', 'onnxscript', 'onnx_graphsurgeon', 'onnxruntime'):
        try: packages[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError: packages[package] = 'unavailable'
    plugin = vs.core.trt.Version()
    plugin = {str(k): v.decode(errors='replace') if isinstance(v, bytes) else str(v) for k, v in plugin.items()}
    if plugin.get('path') and Path(plugin['path']).is_file():
        plugin['binarySha256'] = cached_digest(plugin['path'])
    _IDENTITY = {'platform': platform.system(), 'machine': platform.machine(), 'tensorrt': trt.__version__,
                 'gpu': bytes(uuid).hex(), 'cudaDriver': version.value, 'plugin': plugin,
                 'adapter': ADAPTER, 'engineAbi': ENGINE_ABI, 'helper': digest(__file__), 'packages': packages}
    return _IDENTITY


def engine_details(engine_path):
    import tensorrt as trt
    logger = trt.Logger(trt.Logger.ERROR)
    trt.init_libnvinfer_plugins(logger, '')
    runtime = trt.Runtime(logger)
    with open(engine_path, 'rb') as stream: engine = runtime.deserialize_cuda_engine(stream.read())
    if engine is None: raise RuntimeError('TensorRT could not deserialize the built engine with the installed runtime.')
    inputs, outputs = [], []
    for i in range(engine.num_io_tensors):
        name = engine.get_tensor_name(i)
        item = {'name': name, 'shape': list(engine.get_tensor_shape(name)), 'dtype': str(engine.get_tensor_dtype(name))}
        if engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT:
            item['profiles'] = [[list(shape) for shape in engine.get_tensor_profile_shape(name, p)] for p in range(engine.num_optimization_profiles)] if any(n < 0 for n in item['shape']) else []
            inputs.append(item)
        else: outputs.append(item)
    return {'inputs': inputs, 'outputs': outputs}


def covers(binding, shape):
    if len(binding['shape']) != len(shape): return False
    if all(n > 0 for n in binding['shape']): return binding['shape'] == shape
    return any(all(low <= value <= high for low, value, high in zip(profile[0], shape, profile[2])) for profile in binding.get('profiles', []))


_GRAPH_FALLBACKS = set()


def trt_model(clips, engine_path, streams, use_cuda_graph=False):
    """Replay CUDA launches when supported, without changing the engine or precision.

    Graph capture occurs while vstrt constructs the filter. If construction
    fails, the ordinary path must itself succeed before we report a fallback.
    Failure of both paths preserves the original exception as its cause.
    """
    import vapoursynth as vs
    key = (str(engine_path), streams)
    args = dict(engine_path=str(engine_path), num_streams=streams)
    if use_cuda_graph and key not in _GRAPH_FALLBACKS:
        try:
            output = vs.core.trt.Model(clips, use_cuda_graph=True, **args)
        except Exception as graph_error:
            try:
                output = vs.core.trt.Model(clips, **args)
            except Exception as ordinary_error:
                raise ordinary_error from graph_error
            _GRAPH_FALLBACKS.add(key)
            print(f'[vk-performance] CUDA Graphs unavailable for {Path(engine_path).name}; '
                  f'using ordinary inference. {graph_error}', file=sys.stderr, flush=True)
            return output
        print(f'[vk-performance] CUDA Graphs enabled for {Path(engine_path).name}', file=sys.stderr, flush=True)
        return output
    return vs.core.trt.Model(clips, **args)


def raw_model(clips, engine_path, streams, details, use_cuda_graph=False):
    import vapoursynth as vs
    data_type = details['inputs'][0]['dtype'].lower()
    if data_type not in ('datatype.float', 'datatype.half', 'float32', 'float16'):
        raise RuntimeError('The engine I/O type is unsupported by the VapourSynth RGB adapter: ' + data_type)
    fmt = vs.RGBS if data_type in ('datatype.float', 'float32') else vs.RGBH
    clips = [vs.core.resize.Point(clip, format=fmt) for clip in clips]
    return trt_model(clips, engine_path, streams, use_cuda_graph)


class EngineValidationError(RuntimeError):
    def __init__(self, kind, report):
        self.kind, self.report = kind, report
        super().__init__('Engine validation failed (' + kind + '): ' + json.dumps(report, sort_keys=True))


def compare_engine_output(actual, expected, shape, input_dtype, output_dtype):
    import numpy as np
    context = {'inputShape': list(shape), 'engineInputType': input_dtype, 'engineOutputType': output_dtype,
               'actualOutputShape': list(actual.shape), 'referenceOutputShape': list(expected.shape)}
    if actual.shape != expected.shape: raise EngineValidationError('shape-mismatch', context)
    if not np.isfinite(actual).all() or not np.isfinite(expected).all():
        raise EngineValidationError('nonfinite-output', context)
    error = np.abs(actual.astype(np.float64) - expected.astype(np.float64))
    tolerance = 0.01 + 0.02 * np.abs(expected)
    worst = np.unravel_index(int(error.argmax()), error.shape)
    context.update(maxAbsoluteError=float(error.max()), meanAbsoluteError=float(error.mean()),
                   worstCoordinate=[int(i) for i in worst], actualAtWorst=float(actual[worst]), referenceAtWorst=float(expected[worst]),
                   mismatchFraction=float(np.mean(error > tolerance)), rtol=0.02, atol=0.01)
    if np.any(error > tolerance): raise EngineValidationError('accuracy-mismatch', context)
    return context


REFERENCE_TIMEOUT = 60
REFERENCE_INPUT_BUDGET = 128 * 1024 * 1024
REFERENCE_OUTPUT_BUDGET = 256 * 1024 * 1024


def reference_output(source, input_name, output_name, data):
    """Bound CPU reference work separately from the GPU-owning builder."""
    import tempfile
    import numpy as np
    if data.nbytes > REFERENCE_INPUT_BUDGET:
        raise EngineValidationError('reference-budget', {'inputBytes': int(data.nbytes), 'budgetBytes': REFERENCE_INPUT_BUDGET,
            'remedy': 'Build a profile with a smaller supported validation shape, or use tiling. The candidate has not been certified.'})
    with tempfile.TemporaryDirectory(prefix='vk-reference-') as folder:
        root = Path(folder)
        np.save(root / 'input.npy', data, allow_pickle=False)
        request = {'source': str(Path(source).resolve()), 'input': input_name, 'output': output_name}
        (root / 'request.json').write_text(json.dumps(request), encoding='utf8')
        with open(root / 'stderr.txt', 'w+b') as errors:
            try:
                result = subprocess.run([sys.executable, '-I', str(Path(__file__).resolve()), '--reference', str(root / 'request.json')],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, timeout=REFERENCE_TIMEOUT, check=False)
            except subprocess.TimeoutExpired:
                raise EngineValidationError('reference-timeout', {'timeoutSeconds': REFERENCE_TIMEOUT,
                    'remedy': 'Reference inference exceeded its time budget. Use a smaller supported build profile or tiling; the candidate was not published.'}) from None
            if result.returncode:
                errors.seek(0, 2); end = errors.tell(); errors.seek(max(0, end - 4000))
                raise EngineValidationError('reference-failed', {'details': errors.read().decode(errors='replace'),
                    'remedy': 'Check the original ONNX and its supported shape. If onnxruntime is missing, repair the NVIDIA plugin dependencies.'})
        output = root / 'output.npy'
        if output.stat().st_size > REFERENCE_OUTPUT_BUDGET + 1024:
            raise EngineValidationError('reference-budget', {'outputBytes': output.stat().st_size, 'budgetBytes': REFERENCE_OUTPUT_BUDGET})
        return np.load(output, allow_pickle=False).astype(np.float32)


def reference_worker(request_file):
    import numpy as np
    import onnxruntime as ort
    root = Path(request_file).parent
    request = json.loads(Path(request_file).read_text(encoding='utf8'))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    session = ort.InferenceSession(request['source'], sess_options=options, providers=['CPUExecutionProvider'])
    data = np.load(root / 'input.npy', allow_pickle=False)
    if data.nbytes > REFERENCE_INPUT_BUDGET: raise RuntimeError('Reference input exceeds the byte budget.')
    output = session.run([request['output']], {request['input']: data})[0]
    if output.nbytes > REFERENCE_OUTPUT_BUDGET: raise RuntimeError('Reference output exceeds the byte budget.')
    np.save(root / 'output.npy', output, allow_pickle=False)


def validate_engine(engine_path, opts):
    """Real plugin inference, not only deserialization or clip metadata."""
    import numpy as np
    import vapoursynth as vs
    details = engine_details(engine_path)
    if opts.get('adapter') != ADAPTER:
        return {'schema': SCHEMA, 'runtime': runtime_identity(), 'bindings': details,
                'engineSha256': digest(engine_path), 'validation': {'execution': [], 'accuracy': 'requires-wrapper-validation'}}
    contract = graph_contract(opts['onnx'])
    if len(details['inputs']) != 1 or len(details['outputs']) != 1: raise RuntimeError('Built engine needs a dedicated multi-tensor adapter.')
    binding = details['inputs'][0]
    shapes = binding['profiles'][0] if binding.get('profiles') else [binding['shape']]
    # Test profile endpoints as well as optimum, exposing invalid shape tactics.
    results = []
    accuracy = {'status': 'not-compared', 'samples': [], 'scope': 'first-profile-shape'}
    input_type = binding['dtype'].lower()
    if input_type not in ('datatype.float', 'datatype.half', 'float32', 'float16'):
        raise RuntimeError('Unsupported engine input type for RGB validation: ' + input_type)
    for shape in sorted(set(tuple(s) for s in shapes)):
        n, channels, height, width = shape
        if n != 1 or channels != contract['inputs'][0]['shape'][1]: raise RuntimeError('Engine profile disagrees with the ONNX RGB contract.')
        clip = vs.core.std.BlankClip(width=width, height=height, format=vs.RGBS, length=3, color=[0.2, 0.4, 0.6])
        # Read the exact planes supplied to TensorRT, after its I/O cast. The
        # original ONNX may expose FP32 while the built engine exposes FP16.
        fmt = vs.RGBH if input_type in ('datatype.half', 'float16') or contract['inputs'][0]['dtype'] == 10 else vs.RGBS
        supplied = vs.core.resize.Point(clip, format=fmt)
        window = [supplied] * (channels // 3)
        output = raw_model(window, engine_path, 1, details)
        for index in (0, 2):
            frame = output.get_frame(index)
            if not all(np.isfinite(np.asarray(frame[p])).all() for p in range(frame.format.num_planes)):
                raise EngineValidationError('nonfinite-output', {'inputShape':list(shape), 'frame':index, 'engineInputType':input_type})
        if not results:
            dtype = np.float16 if contract['inputs'][0]['dtype'] == 10 else np.float32
            input_bytes = int(np.prod(shape)) * np.dtype(dtype).itemsize
            if input_bytes > REFERENCE_INPUT_BUDGET:
                raise EngineValidationError('reference-budget', {'inputBytes': input_bytes, 'budgetBytes': REFERENCE_INPUT_BUDGET, 'inputShape': list(shape)})
            data = np.empty(shape, dtype=dtype)
            for index, sample in enumerate(window):
                frame = sample.get_frame(0)
                for plane in range(3): data[0, index * 3 + plane] = np.asarray(frame[plane])
            expected = reference_output(opts['onnx'], contract['inputs'][0]['name'], contract['outputs'][0]['name'], data)
            frame = output.get_frame(0)
            actual = np.stack([np.asarray(frame[p], dtype=np.float32) for p in range(3)])[None]
            report = compare_engine_output(actual, expected, shape, input_type, details['outputs'][0]['dtype'])
            accuracy['status'] = 'passed'
            accuracy['reference'] = 'onnxruntime-cpu'
            accuracy['samples'].append(report)
        results.append({'input': list(shape), 'output': [output.height, output.width]})
        del output, clip, supplied, window
    return {'schema': SCHEMA, 'contract': contract, 'sourceRelative': os.path.relpath(opts['onnx'], Path(engine_path).parent), 'runtime': runtime_identity(), 'bindings': details,
            'precision': 'fp32' if not (opts['fp16'] or opts['bf16']) else 'bf16' if opts['bf16'] else 'fp16',
            'engineSha256': digest(engine_path), 'validation': {'execution': results, 'accuracy': accuracy}}


def engine_metadata(engine_path):
    """The build manifest of an engine, or None for engines built without one."""
    try:
        value = json.loads(Path(str(engine_path) + '.json').read_text())
        if not isinstance(value, dict) or value.get('schema') != SCHEMA: return None
        bindings = value.get('bindings')
        inputs = bindings.get('inputs') if isinstance(bindings, dict) else None
        if not isinstance(inputs, list) or not inputs or not all(isinstance(i, dict) and isinstance(i.get('shape'), list) for i in inputs): return None
        # A manifest describes one exact engine file; a replaced engine falls back to probing.
        if not isinstance(value.get('engineSha256'), str) or value['engineSha256'] != cached_digest(engine_path): return None
        return value
    except (ValueError, OSError, TypeError): return None


def source_model(engine_path, manifest):
    """Locate the ONNX an engine was built from, as recorded or by filename pairing."""
    import re
    candidates = []
    if manifest and isinstance(manifest.get('sourceRelative'), str):
        candidates.append(engine_path.parent / manifest['sourceRelative'])
    candidates.append(engine_path.with_suffix('.onnx'))
    candidates.append(Path(re.sub(r'_(fp16|fp32|bf16)\.engine$', '.onnx', str(engine_path), flags=re.IGNORECASE)))
    return next((c for c in candidates if c.is_file()), None)


def model_descriptor(source):
    """Spatial multiple and scale recorded for a model package, if any."""
    if source is None: return {}
    try: value = json.loads(Path(str(source) + '.contract.json').read_text())
    except (OSError, ValueError): return {}
    return value if isinstance(value, dict) else {}


def profile_range(binding):
    shape = binding['shape']
    if all(n > 0 for n in shape): return f'only {shape[3]}x{shape[2]}'
    ranges = [f'{p[0][3]}x{p[0][2]} to {p[2][3]}x{p[2][2]}' for p in binding.get('profiles', [])]
    return ' or '.join(ranges) if ranges else 'an unknown range'


def probed_model(clips, engine_path, streams, use_cuda_graph=False):
    """Run an engine without a manifest, retrying once in the other float format.

    vstrt needs the engine's I/O type, which comes from the ONNX: an FP16
    export that keeps FP32 graph inputs builds an engine that wants RGBS.
    """
    import vapoursynth as vs
    try:
        return trt_model(clips, engine_path, streams, use_cuda_graph)
    except vs.Error as error:
        if 'bits per sample mismatch' not in str(error): raise
    fmt = vs.RGBS if clips[0].format.bits_per_sample == 16 else vs.RGBH
    return trt_model([vs.core.resize.Point(c, format=fmt) for c in clips], engine_path, streams, use_cuda_graph)


def load_model(clips, engine_path, streams, use_cuda_graph=False, **_unused):
    """Run a prebuilt engine. A dynamic engine serves every size inside its profile."""
    supplied_window = isinstance(clips, list)
    clips = list(clips) if supplied_window else [clips]
    first = clips[len(clips) // 2]
    if any((c.width, c.height) != (first.width, first.height) for c in clips): raise RuntimeError('Temporal input dimensions differ.')
    if first.width <= 0 or first.height <= 0: raise RuntimeError('Resize variable-resolution input before this model; fixed stage dimensions are required.')
    engine_path = Path(engine_path)
    if engine_path.suffix.lower() != '.engine' or not engine_path.is_file():
        raise RuntimeError('TensorRT engine not found: ' + str(engine_path) + '. Build the model in Vapourkit before processing.')
    manifest = engine_metadata(engine_path)
    binding = manifest['bindings']['inputs'][0] if manifest else None
    channels = binding['shape'][1] if binding and len(binding['shape']) == 4 else None
    if isinstance(channels, int) and channels > 0 and channels % 3 == 0 and channels // 3 != len(clips):
        # The generator's VSR list is centered, so its middle clip is the source.
        clips = temporal_window(first, channels // 3) if channels > 3 else [first]
    descriptor = model_descriptor(source_model(engine_path, manifest))
    multiple = descriptor.get('spatialMultiple', 1)
    if not isinstance(multiple, int) or not 1 <= multiple <= 256: raise RuntimeError('Invalid model spatial multiple in ' + str(engine_path) + '.')
    original = (first.width, first.height)
    if first.width % multiple or first.height % multiple:
        import vapoursynth as vs
        right, bottom = (-first.width) % multiple, (-first.height) % multiple
        clips = [vs.core.std.AddBorders(c, right=right, bottom=bottom) for c in clips]
    shape = [1, len(clips) * 3, clips[0].height, clips[0].width]
    if binding is not None and not covers(binding, shape):
        if channels != shape[1]: raise RuntimeError('Configured temporal window disagrees with the engine. Reimport the model with automatic detection.')
        raise RuntimeError(f'This TensorRT engine accepts {profile_range(binding)} (width x height), but this stage sends {shape[3]}x{shape[2]}. '
                           'Rebuild the engine with a shape range that covers this resolution, or resize before the model.')
    graph_options = {'use_cuda_graph': True} if use_cuda_graph else {}
    output = raw_model(clips, engine_path, streams, manifest['bindings'], **graph_options) if manifest else probed_model(clips, engine_path, streams, **graph_options)
    expected_scale = descriptor.get('scale')
    if expected_scale and (output.width != clips[0].width * expected_scale or output.height != clips[0].height * expected_scale):
        raise RuntimeError('The model output dimensions disagree with its catalog adapter. Keep the previous model and report this catalog entry.')
    if original != (clips[0].width, clips[0].height):
        import vapoursynth as vs
        right = (clips[0].width - original[0]) * output.width / clips[0].width
        bottom = (clips[0].height - original[1]) * output.height / clips[0].height
        if not right.is_integer() or not bottom.is_integer(): raise RuntimeError('Cannot crop padding for this model output scale.')
        output = vs.core.std.CropRel(output, right=int(right), bottom=int(bottom))
    return output


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--reference':
        try: reference_worker(sys.argv[2])
        except Exception as error:
            print('ONNX reference validation failed: ' + str(error), file=sys.stderr)
            raise SystemExit(1)
        raise SystemExit(0)
    if len(sys.argv) != 3 or sys.argv[1] != '--inspect-bindings':
        raise SystemExit('Usage: vk_model_runtime.py --inspect-bindings MODEL.onnx')
    try:
        _, inputs, outputs = inspect_bindings(sys.argv[2])
        print(json.dumps({'inputs': inputs, 'outputs': outputs}))
    except Exception as error:
        print('ONNX shape inspection failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
