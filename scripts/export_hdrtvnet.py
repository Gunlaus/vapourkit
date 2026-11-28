"""Reproduce the pinned HDRTVNet++ AGCM+LE export; never run at app startup."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn
import torch.nn.functional as F
from hdrtvnet_arch import Ensemble_AGCM_LE
from hdrtvnet_resize_reference import imresize

UPSTREAM = 'c77ad33a2d186482ef1f4d23990cbf39d8dbd727'
WEIGHTS_SHA256 = '7cb7be146e5912826dc652c43a8512e47cd58de46abdfa200f6e3a7e5b74e040'
WEIGHTS_URL = f'https://raw.githubusercontent.com/xiaom233/HDRTVNet-plus/{UPSTREAM}/pretrained_models/Ensemble_AGCM_LE.pth'
# Exact antialiased MATLAB-style cubic quarter-scale kernel from upstream
# calculate_weights_indices(128, 32, .25, 'cubic', 4, True). Boundary extension
# is symmetric (includes the edge sample), rather than reflect padding.
KERNEL = [-.001708984375, -.010986328125, -.018310546875, -.011962890625,
          .022705078125, .097412109375, .181884765625, .240966796875,
          .240966796875, .181884765625, .097412109375, .022705078125,
          -.011962890625, -.018310546875, -.010986328125, -.001708984375]


class QuarterCondition(nn.Module):
    def __init__(self):
        super().__init__()
        weights = torch.tensor(KERNEL, dtype=torch.float32)
        self.register_buffer('vertical', weights.reshape(1, 1, 16, 1).repeat(3, 1, 1, 1))
        self.register_buffer('horizontal', weights.reshape(1, 1, 1, 16).repeat(3, 1, 1, 1))

    def forward(self, x):
        x = torch.cat((x[:, :, :6, :].flip(2), x, x[:, :, -6:, :].flip(2)), 2)
        x = F.conv2d(x, self.vertical, stride=(4, 1), groups=3)
        x = torch.cat((x[:, :, :, :6].flip(3), x, x[:, :, :, -6:].flip(3)), 3)
        return F.conv2d(x, self.horizontal, stride=(1, 4), groups=3)


class HdrTvNet(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net, self.condition = net, QuarterCondition()

    def forward(self, pixels):
        h, w = pixels.shape[2], pixels.shape[3]
        padded = F.pad(pixels.clamp(0, 1), (0, (-w) % 8, 0, (-h) % 8), mode='reflect')
        output = self.net([padded, self.condition(padded)])[0]
        return output[:, :, :h, :w].clamp(0, 1)


def lower_instance_norm(graph):
    # Express per-channel spatial normalization using portable primitives;
    # avoid depending on a vendor InstanceNormalization plugin for dynamic H/W.
    nodes = []
    for index, node in enumerate(graph.graph.node):
        if node.op_type != 'InstanceNormalization':
            nodes.append(node); continue
        root = f'__vk_inorm_{index}'
        eps = next((attr.f for attr in node.attribute if attr.name == 'epsilon'), 1e-5)
        for name, value in [(root + '_eps', np.array(eps, dtype=np.float32)),
                            (root + '_shape', np.array([1, -1, 1, 1], dtype=np.int64))]:
            graph.graph.initializer.append(onnx.numpy_helper.from_array(value, name))
        def add(kind, inputs, output, **attrs):
            nodes.append(onnx.helper.make_node(kind, inputs, [output], **attrs))
        x, scale, bias = node.input
        add('ReduceMean', [x], root + '_mean', axes=[2, 3], keepdims=1)
        add('Sub', [x, root + '_mean'], root + '_centered')
        add('Mul', [root + '_centered', root + '_centered'], root + '_squared')
        add('ReduceMean', [root + '_squared'], root + '_variance', axes=[2, 3], keepdims=1)
        add('Add', [root + '_variance', root + '_eps'], root + '_denom2')
        add('Sqrt', [root + '_denom2'], root + '_denom')
        add('Div', [root + '_centered', root + '_denom'], root + '_normalized')
        add('Reshape', [scale, root + '_shape'], root + '_scale')
        add('Reshape', [bias, root + '_shape'], root + '_bias')
        add('Mul', [root + '_normalized', root + '_scale'], root + '_scaled')
        add('Add', [root + '_scaled', root + '_bias'], node.output[0])
    graph.graph.ClearField('node'); graph.graph.node.extend(nodes)


def export(checkpoint, output):
    if hashlib.sha256(checkpoint.read_bytes()).hexdigest() != WEIGHTS_SHA256:
        raise ValueError('HDRTVNet++ checkpoint does not match the pinned upstream release.')
    torch.set_num_threads(2)
    torch.manual_seed(123)
    net = Ensemble_AGCM_LE(cond_c=6, nf=32, weighting_network=False)
    net.load_state_dict(torch.load(checkpoint, map_location='cpu', weights_only=True), strict=True)
    net.eval()
    model = HdrTvNet(net).eval()
    sample = torch.rand(1, 3, 128, 160)
    resize_error = 0.0
    for h, w in [(128, 160), (152, 176), (240, 320)]:
        pixels = torch.rand(1, 3, h, w)
        actual = model.condition(pixels)
        expected = imresize(pixels[0], .25)[None]
        torch.testing.assert_close(actual, expected, atol=1e-6, rtol=1e-6)
        resize_error = max(resize_error, float((actual - expected).abs().max()))
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(model, sample, str(output), opset_version=17, dynamo=False,
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {2: 'height', 3: 'width'}, 'output': {2: 'height', 3: 'width'}})
    graph = onnx.load(output)
    lower_instance_norm(graph)
    # Dynamic padding/cropping obscures these fixed axes in the legacy exporter.
    # This architecture is structurally RGB -> RGB with batch 1; spatial axes
    # remain dynamic and are checked against actual inference below.
    graph.graph.output[0].type.tensor_type.shape.dim[0].dim_value = 1
    graph.graph.output[0].type.tensor_type.shape.dim[1].dim_value = 3
    for key, value in {'vk.hdr.model': 'HDRTVNet++ AGCM+LE', 'vk.hdr.source': UPSTREAM,
                       'vk.hdr.input': 'RGB BT.709 SDR full range [0,1]',
                       'vk.hdr.output': 'RGB BT.2020 PQ full range [0,1]'}.items():
        entry = graph.metadata_props.add(); entry.key, entry.value = key, value
    onnx.checker.check_model(graph)
    onnx.save(graph, output)
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'include'))
    import vk_model_runtime
    contract = vk_model_runtime.graph_contract(output)
    assert contract['inputs'][0]['shape'][:2] == [1, 3]
    assert contract['outputs'][0]['shape'][:2] == [1, 3]
    opts = ort.SessionOptions(); opts.intra_op_num_threads = 2
    session = ort.InferenceSession(str(output), sess_options=opts, providers=['CPUExecutionProvider'])
    reports = []
    for h, w in [(128, 160), (149, 173), (240, 320)]:
        for kind in ['random', 'black', 'white', 'gradient']:
            data = torch.rand(1, 3, h, w)
            if kind == 'black': data.zero_()
            elif kind == 'white': data.fill_(1)
            elif kind == 'gradient': data = torch.linspace(0, 1, w).reshape(1, 1, 1, w).expand(1, 3, h, w).contiguous()
            with torch.inference_mode(): expected = model(data).numpy()
            actual = session.run(None, {'input': data.numpy()})[0]
            np.testing.assert_allclose(actual, expected, atol=2e-4, rtol=2e-4)
            assert actual.shape == (1, 3, h, w) and np.isfinite(actual).all()
            reports.append({'shape': [h, w], 'input': kind, 'maxAbsError': float(np.max(np.abs(actual - expected)))})
    metadata = dict(resizeReferenceMaxAbsError=resize_error, upstream=UPSTREAM, checkpointSha256=WEIGHTS_SHA256,
                    modelSha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                    input='BT.709 SDR RGB [0,1]', output='BT.2020 PQ RGB [0,1]',
                    minimumDimension=128, internalPadding='reflect to multiple of 8, cropped after inference',
                    condition='symmetric antialiased cubic quarter-scale, full frame',
                    hallucination=False, validation=reports)
    output.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('include/hdrtvnet/AGCM_LE.onnx'))
    args = parser.parse_args()
    if not args.checkpoint.exists():
        args.checkpoint.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(WEIGHTS_URL, args.checkpoint)
    export(args.checkpoint, args.output)
