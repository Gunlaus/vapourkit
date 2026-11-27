"""Create a cached FP32-boundary ONNX adapter without changing model internals."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import onnx
from onnx import TensorProto, helper

VERSION = 1


def ready(target):
    try:
        result = json.loads((target / 'ready.json').read_text())
        if result['schema'] != VERSION or 'model.onnx' not in result['files']: return None
        for name, signature in result['signatures'].items():
            if Path(name).name != name: return None
            stat = (target / name).stat()
            if [stat.st_size, stat.st_mtime_ns] != signature: return None
        return result if set(result['files']) == set(result['signatures']) else None
    except (OSError, ValueError, KeyError, TypeError): return None


def tensors(graph):
    yield from graph.initializer
    for sparse in graph.sparse_initializer:
        yield sparse.values
        yield sparse.indices
    for node in graph.node:
        for attr in node.attribute:
            if attr.HasField('t'): yield attr.t
            yield from attr.tensors
            if attr.HasField('g'): yield from tensors(attr.g)
            for child in attr.graphs: yield from tensors(child)


def prepare(source, cache):
    source, cache = Path(source).resolve(), Path(cache)
    graph = onnx.load_model(source, load_external_data=False)
    initializers = {t.name for t in graph.graph.initializer}
    inputs = [v for v in graph.graph.input if v.name not in initializers]
    outputs = list(graph.graph.output)
    if len(inputs) != 1 or len(outputs) != 1:
        raise ValueError('NVEncC requires a single-input/single-output RGB image model.')
    files = {str(source): [source.stat().st_size, source.stat().st_mtime_ns]}
    for tensor in tensors(graph.graph):
        if tensor.data_location == TensorProto.EXTERNAL:
            values = {v.key: v.value for v in tensor.external_data}
            location = values.get('location', '')
            file = (source.parent / location).resolve()
            if not location or not file.is_relative_to(source.parent):
                raise ValueError('External weights must stay inside the model package.')
            files[str(file)] = [file.stat().st_size, file.stat().st_mtime_ns]
    key = hashlib.sha256(json.dumps([VERSION, files], sort_keys=True).encode()).hexdigest()[:24]
    target = cache / key
    existing = ready(target)
    if existing: return {**existing, 'model': str(target / 'model.onnx')}
    try:
        inferred = onnx.shape_inference.infer_shapes(graph)
        graph = inferred
    except Exception:
        pass
    inputs = [v for v in graph.graph.input if v.name not in initializers]
    source_input, source_output = inputs[0], graph.graph.output[0]
    shapes = []
    for value in (source_input, source_output):
        tensor = value.type.tensor_type
        shape = [int(d.dim_value) if d.HasField('dim_value') else d.dim_param for d in tensor.shape.dim]
        if len(shape) != 4 or shape[1] != 3 or (isinstance(shape[0], int) and shape[0] != 1):
            raise ValueError('NVEncC currently supports NCHW RGB image models with three input/output channels.')
        if tensor.elem_type not in (TensorProto.FLOAT, TensorProto.FLOAT16):
            raise ValueError('NVEncC currently supports FP32 and FP16 models; BF16/quantized model interfaces need another adapter.')
        shapes.append(shape)
    # Load weights only on a cache miss. No conversion of operators or weights.
    onnx.external_data_helper.load_external_data_for_model(graph, str(source.parent))
    names = {n for node in graph.graph.node for n in list(node.input) + list(node.output)} | {v.name for v in graph.graph.input} | {v.name for v in graph.graph.initializer}
    def unique(base):
        while base in names: base += '_'
        names.add(base)
        return base
    external_input, clamped, external_output = (unique('__vk_nvencc_input'), unique('__vk_nvencc_clamped'), unique('__vk_nvencc_output'))
    old_input, old_output = copy.deepcopy(source_input), copy.deepcopy(source_output)
    source_input.name = external_input
    source_input.type.tensor_type.elem_type = TensorProto.FLOAT
    source_output.name = external_output
    source_output.type.tensor_type.elem_type = TensorProto.FLOAT
    graph.graph.value_info.append(old_input)
    if old_output.name != old_input.name: graph.graph.value_info.append(old_output)
    minimum, maximum = unique('__vk_min'), unique('__vk_max')
    graph.graph.initializer.extend([helper.make_tensor(minimum, TensorProto.FLOAT, [], [0.0]), helper.make_tensor(maximum, TensorProto.FLOAT, [], [1.0])])
    # Clip matches Vapourkit's normalized RGB input clamp.
    if next((o.version for o in graph.opset_import if o.domain == ''), 0) < 11:
        raise ValueError('Re-export this model with ONNX opset 11 or newer for NVEncC.')
    nodes = list(graph.graph.node)
    del graph.graph.node[:]
    graph.graph.node.extend([
        helper.make_node('Clip', [external_input, minimum, maximum], [clamped]),
        helper.make_node('Cast', [clamped], [old_input.name], to=old_input.type.tensor_type.elem_type),
        *nodes,
        helper.make_node('Cast', [old_output.name], [external_output], to=TensorProto.FLOAT),
    ])
    cache.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.prepare-', dir=cache))
    try:
        # Materialize a self-contained package; the original external-data files stay untouched.
        onnx.save_model(graph, stage / 'model.onnx', save_as_external_data=True, all_tensors_to_one_file=True, location='weights.bin', size_threshold=1024)
        onnx.checker.check_model(str(stage / 'model.onnx'))
        result = {'schema': VERSION, 'source': str(source), 'inputShape': shapes[0], 'outputShape': shapes[1],
                  'files': [p.name for p in stage.iterdir() if p.is_file()]}
        result['signatures'] = {p.name: [p.stat().st_size, p.stat().st_mtime_ns] for p in stage.iterdir() if p.is_file()}
        (stage / 'ready.json').write_text(json.dumps(result), encoding='utf-8')
        if ready(target): shutil.rmtree(stage)
        else:
            # Only generated cache directories are replaceable, never the source package.
            previous = None
            if target.exists():
                previous = Path(tempfile.mkdtemp(prefix='.old-', dir=cache))
                previous.rmdir()
                os.replace(target, previous)
            try: os.replace(stage, target)
            except OSError:
                if previous is not None and not target.exists(): os.replace(previous, target)
                raise
            if previous is not None: shutil.rmtree(previous)
        return {**result, 'model': str(target / 'model.onnx')}
    finally:
        if stage.exists(): shutil.rmtree(stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--cache', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.source, args.cache)))
    except Exception as error:
        parser.exit(1, 'NVEncC model preparation failed: ' + str(error) + '\n')
