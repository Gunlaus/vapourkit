"""Model/engine compatibility shared by the builder and VapourSynth runtime.

Engine files are disposable caches. Model packages and saved workflows are not.
No third-party Python adapters or native plugins are downloaded by this module.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

SCHEMA = 1
ADAPTER = 'rgb-window-v1'
_IDENTITY = None


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


def graph_contract(source):
    import onnx
    model = onnx.load(str(source), load_external_data=False)
    initializers = {tensor.name for tensor in model.graph.initializer}
    inputs = [item for item in model.graph.input if item.name not in initializers]
    outputs = list(model.graph.output)
    def binding(item):
        value = item.type.tensor_type
        return {'name': item.name, 'dtype': int(value.elem_type),
                'shape': [int(d.dim_value) if d.HasField('dim_value') else d.dim_param or None for d in value.shape.dim]}
    ins, outs = list(map(binding, inputs)), list(map(binding, outputs))
    if len(ins) != 1 or len(outs) != 1 or any(len(item['shape']) != 4 for item in ins + outs):
        raise RuntimeError('This model needs a dedicated tensor-layout adapter; automatic RGB setup supports one NCHW input and output.')
    channels = ins[0]['shape'][1]
    if not isinstance(channels, int) or channels < 3 or channels % 3 or (channels // 3) % 2 == 0 or outs[0]['shape'][1] != 3:
        raise RuntimeError('Unsupported RGB temporal layout. Use an image model or an odd channel-packed RGB window.')
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
    current = driver.cuCtxGetDevice(ctypes.byref(device))
    if current:
        selected = os.environ.get('CUDA_VISIBLE_DEVICES', '0').split(',')[0]
        if selected.isdigit(): checked(driver.cuDeviceGet(ctypes.byref(device), int(selected)))
        else:
            # UUID masks are resolved by the CUDA runtime, not physical ordinals.
            raise RuntimeError('Cannot identify the selected CUDA UUID without an active context. Retry after initializing this GPU.')
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
    _IDENTITY = {'platform': platform.system(), 'machine': platform.machine(), 'tensorrt': trt.__version__,
                 'gpu': bytes(uuid).hex(), 'cudaDriver': version.value, 'plugin': plugin,
                 'adapter': ADAPTER, 'helper': digest(__file__), 'packages': packages}
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


def raw_model(clips, engine_path, streams, details):
    import vapoursynth as vs
    data_type = details['inputs'][0]['dtype'].lower()
    if data_type not in ('datatype.float', 'datatype.half', 'float32', 'float16'):
        raise RuntimeError('The engine I/O type is unsupported by the VapourSynth RGB adapter: ' + data_type)
    fmt = vs.RGBS if data_type in ('datatype.float', 'float32') else vs.RGBH
    clips = [vs.core.resize.Point(clip, format=fmt) for clip in clips]
    return vs.core.trt.Model(clips, engine_path=str(engine_path), num_streams=streams)


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
    accuracy = {'status': 'not-compared'}
    reference = None
    try:
        import onnxruntime as ort
        reference = ort.InferenceSession(str(opts['onnx']), providers=['CPUExecutionProvider'])
    except Exception as error:
        accuracy = {'status': 'reference-unavailable', 'reason': str(error)[:1000]}
    for shape in sorted(set(tuple(s) for s in shapes)):
        n, channels, height, width = shape
        if n != 1 or channels != contract['inputs'][0]['shape'][1]: raise RuntimeError('Engine profile disagrees with the ONNX RGB contract.')
        clip = vs.core.std.BlankClip(width=width, height=height, format=vs.RGBS, length=3, color=[0.2, 0.4, 0.6])
        output = raw_model([clip] * (channels // 3), engine_path, 1, details)
        for index in (0, 2):
            frame = output.get_frame(index)
            if not all(np.isfinite(np.asarray(frame[p])).all() for p in range(frame.format.num_planes)):
                raise RuntimeError('Engine produced NaN/Inf values. Use a validated higher-precision export.')
        if reference is not None and not results:
            dtype = np.float16 if contract['inputs'][0]['dtype'] == 10 else np.float32
            data = np.empty(shape, dtype=dtype)
            for channel in range(channels): data[0, channel].fill([0.2, 0.4, 0.6][channel % 3])
            expected = reference.run([contract['outputs'][0]['name']], {contract['inputs'][0]['name']: data})[0].astype(np.float32)
            frame = output.get_frame(0)
            actual = np.stack([np.asarray(frame[p], dtype=np.float32) for p in range(3)])[None]
            if actual.shape != expected.shape or not np.allclose(actual, expected, rtol=0.02, atol=0.01, equal_nan=False):
                raise RuntimeError('Engine accuracy comparison failed against ONNX Runtime. Use a higher-precision source/build; the previous engine was kept.')
            accuracy = {'status': 'passed', 'reference': 'onnxruntime-cpu', 'maxAbsoluteError': float(np.abs(actual - expected).max()), 'rtol': 0.02, 'atol': 0.01}
        results.append({'input': list(shape), 'output': [output.height, output.width]})
        del output, clip
    return {'schema': SCHEMA, 'contract': contract, 'sourceRelative': os.path.relpath(opts['onnx'], Path(engine_path).parent), 'runtime': runtime_identity(), 'bindings': details,
            'precision': 'fp32' if not (opts['fp16'] or opts['bf16']) else 'bf16' if opts['bf16'] else 'fp16',
            'engineSha256': digest(engine_path), 'validation': {'execution': results, 'accuracy': accuracy}}


def validate_output(output):
    import numpy as np
    for index in sorted({0, min(2, output.num_frames - 1), output.num_frames - 1}):
        frame = output.get_frame(index)
        if not all(np.isfinite(np.asarray(frame[p])).all() for p in range(frame.format.num_planes)):
            raise RuntimeError('The model produced NaN/Inf on the source video. Use a validated higher-precision model/build.')
    return output


_CHECKED = {}
_CONTRACTS = {}

def cached_contract(source):
    def stamp(files):
        result = []
        for file in files:
            p = Path(file)
            if not p.exists(): return None
            s = p.stat(); result.append((str(p), s.st_size, s.st_mtime_ns, s.st_ctime_ns))
        return tuple(result)
    key = str(source.resolve())
    previous = _CONTRACTS.get(key)
    if previous and stamp(previous[0]) == previous[1] and (str(source) + '.contract.json' in previous[0]) == Path(str(source) + '.contract.json').exists(): return previous[2]
    contract = graph_contract(source)
    files = [item['path'] for item in contract['files']]
    descriptor = Path(str(source) + '.contract.json')
    if descriptor.exists(): files.append(str(descriptor))
    # Include the descriptor's existence even when the first read had none.
    signature = (stamp(files), descriptor.exists())
    _CONTRACTS[key] = (files, signature[0], contract)
    return contract

def read_manifest(file):
    try:
        value = json.loads(Path(file).read_text())
        if not isinstance(value, dict) or value.get('schema') != SCHEMA: return None
        if not isinstance(value.get('runtime'), dict) or not isinstance(value.get('bindings'), dict): return None
        inputs = value['bindings'].get('inputs')
        if not isinstance(inputs, list) or not inputs or not all(isinstance(i, dict) and isinstance(i.get('shape'), list) for i in inputs): return None
        if not isinstance(value.get('engineSha256'), str): return None
        if not isinstance(value.get('contract'), dict): return None
        files = value['contract'].get('files')
        if not isinstance(files, list) or not files or not all(isinstance(f, dict) and isinstance(f.get('path'), str) for f in files): return None
        return value
    except (ValueError, OSError, TypeError): return None


def load_model(clips, engine_path, streams, builder, python, precision='fp16'):
    """Select/rebuild for the actual stage shape before any FFmpeg job starts."""
    clips = clips if isinstance(clips, list) else [clips]
    first = clips[0]
    if any((c.width, c.height) != (first.width, first.height) for c in clips): raise RuntimeError('Temporal input dimensions differ.')
    if first.width <= 0 or first.height <= 0: raise RuntimeError('Resize variable-resolution input before this model; fixed stage dimensions are required.')
    original = (first.width, first.height)
    shape = [1, len(clips) * 3, first.height, first.width]
    engine_path = Path(engine_path)
    sidecar = Path(str(engine_path) + '.json')
    manifest = read_manifest(sidecar)
    source = (engine_path.parent / manifest['sourceRelative']).resolve() if manifest and manifest.get('sourceRelative') else Path(manifest['contract']['files'][0]['path']) if manifest and manifest.get('contract') else engine_path.with_suffix('.onnx')
    if not source.is_file() and engine_path.with_suffix('.onnx').is_file(): source = engine_path.with_suffix('.onnx')
    if not source.is_file():
        import re
        source = Path(re.sub(r'_(fp16|fp32|bf16)\.engine$', '.onnx', str(engine_path)))
    if not source.is_file(): raise RuntimeError('This engine has no source ONNX. Import its complete model package to validate or rebuild it.')
    contract = cached_contract(source)
    contract_key = hashlib.sha256(json.dumps(contract, sort_keys=True).encode()).hexdigest()
    check_key = (str(engine_path), tuple(shape), streams, contract_key)
    cached = _CHECKED.get(check_key)
    if cached and Path(cached[0]).exists() and digest(cached[0]) == cached[2]:
        return validate_output(raw_model(clips, cached[0], streams, cached[1]))
    multiple = contract.get('spatialMultiple', 1)
    if first.width % multiple or first.height % multiple:
        import vapoursynth as vs
        right, bottom = (-first.width) % multiple, (-first.height) % multiple
        clips = [vs.core.std.AddBorders(c, right=right, bottom=bottom) for c in clips]
        shape[2:4] = [clips[0].height, clips[0].width]
    if contract['inputs'][0]['shape'][1] != shape[1]: raise RuntimeError('Configured temporal window disagrees with the model. Reimport with automatic detection.')
    expected = contract['inputs'][0]['shape']
    if any(isinstance(n, int) and n > 0 and n != shape[i] for i, n in enumerate(expected)):
        raise RuntimeError('This model has a fixed input shape ' + str(expected) + '; resize/pad before the model or use a dynamic export.')
    identity = runtime_identity()
    healthy = manifest and manifest.get('schema') == SCHEMA and manifest['contract'] == contract and manifest['runtime'] == identity and manifest.get('precision') == ('bf16' if 16 in contract.get('weightTypes', []) else precision)
    if healthy and covers(manifest['bindings']['inputs'][0], shape) and manifest['engineSha256'] == digest(engine_path):
        selected, details = engine_path, manifest['bindings']
    else:
        key = hashlib.sha256(json.dumps([contract, identity, shape, precision], sort_keys=True).encode()).hexdigest()[:24]
        cache = source.parent / 'engines'; cache.mkdir(exist_ok=True)
        selected = cache / (source.stem + '-' + key + '.engine')
        metadata = Path(str(selected) + '.json')
        valid = False
        if selected.exists() and metadata.exists():
            found = read_manifest(metadata)
            valid = found is not None and found.get('runtime') == identity and found.get('contract') == contract and found.get('engineSha256') == digest(selected) and covers(found['bindings']['inputs'][0], shape)
        if not valid:
            dtype = contract['inputs'][0]['dtype']
            # A pretyped BF16 graph cannot be converted by an FP16 command flag.
            selected_precision = 'bf16' if dtype == 16 or 16 in contract.get('weightTypes', []) else precision
            args = [python, '-u', builder, '--onnx=' + str(source), '--saveEngine=' + str(selected),
                    '--shapes=' + contract['inputs'][0]['name'] + ':' + 'x'.join(map(str, shape)), '--builderOptimizationLevel=3', '--vkAdapter=' + ADAPTER]
            if selected_precision != 'fp32': args.append('--' + selected_precision)
            subprocess.run(args, check=True, timeout=1800)
        found = json.loads(metadata.read_text()); details = found['bindings']
    if original == (clips[0].width, clips[0].height): _CHECKED[check_key] = (selected, details, digest(selected))
    output = raw_model(clips, selected, streams, details)
    # Force actual source-frame evaluation before the encode process is launched.
    expected_scale = contract.get('descriptor', {}).get('scale')
    if expected_scale and (output.width != clips[0].width * expected_scale or output.height != clips[0].height * expected_scale):
        raise RuntimeError('The model output dimensions disagree with its catalog adapter. Keep the previous model and report this catalog entry.')
    validate_output(output)
    if original != (clips[0].width, clips[0].height):
        import vapoursynth as vs
        right = (clips[0].width - original[0]) * output.width / clips[0].width
        bottom = (clips[0].height - original[1]) * output.height / clips[0].height
        if not right.is_integer() or not bottom.is_integer(): raise RuntimeError('Cannot crop padding for this model output scale.')
        output = vs.core.std.CropRel(output, right=int(right), bottom=int(bottom))
    return output
