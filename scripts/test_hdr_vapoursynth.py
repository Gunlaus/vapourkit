"""Opt-in target-runtime smoke test; synthetic CPU clips and bundled ONNX model."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'include'))
import vapoursynth as vs
import vk_hdr_runtime as hdr

core = vs.core
core.num_threads = 2
settings = dict(peakNits=1000, referenceWhite=203, strength=.35,
                chroma='auto', sourceTransfer='auto')
defaults = dict(defaultMatrix='709', defaultPrimaries='709')


def pq_code(nits):
    m1, m2 = 2610 / 16384, 2523 / 32
    c1, c2, c3 = 3424 / 4096, 2413 / 128, 2392 / 128
    value = (nits / 10000) ** m1
    return 64 + 876 * ((c1 + c2 * value) / (1 + c3 * value)) ** m2


for level in (0., 1.):
    source = core.std.BlankClip(width=64, height=64, length=2, format=vs.RGBS, color=[level] * 3)
    source = core.std.SetFrameProps(source, _Transfer=1, _Primaries=1, _Matrix=0, _Range=1)
    output = hdr.convert(source, settings)
    frame = output.get_frame(0)
    assert output.format.id == vs.YUV420P10
    assert frame.props['_Transfer'] == 16 and frame.props['_Primaries'] == 9 and frame.props['_Matrix'] == 9
    value = frame[0][0, 0]
    expected = pq_code(hdr.mapped_luminance(level, settings))
    assert abs(value - expected) < 3, f'PQ luminance mismatch: {value} versus {expected}'
    preview = hdr.sdr_preview(output)
    assert preview.get_frame(0).props['_Transfer'] == 1
    print(f'RGB level {level}: PQ code {value}, expected {expected:.3f}; SDR preview OK')

source = core.std.BlankClip(width=64, height=64, length=2, format=vs.YUV420P8, color=[126, 128, 128])
source = core.std.SetFrameProps(source, _Transfer=1, _Primaries=1, _Matrix=1, _Range=0, _ChromaLocation=1)
prepared = hdr.prepare_source(source, settings, defaults)
assert prepared.format.id == vs.YUV444P16
hdr.convert(prepared, settings).get_frame(0)
print('4:2:0 source -> 4:4:4 processing -> 10-bit PQ output OK')

try:
    hdr.prepare_source(core.std.SetFrameProps(source, _Transfer=16), settings, defaults)
except ValueError:
    print('Already-HDR source rejected')
else:
    raise AssertionError('PQ input must not be converted twice')

overridden = hdr.prepare_source(source, dict(settings, sourceMatrix='170m', sourcePrimaries='170m', sourceRange='full'), defaults)
props = overridden.get_frame(0).props
assert props['_Matrix'] == 6 and props['_Primaries'] == 6 and props['_Range'] == 1
print('Independent source overrides OK')
print('VapourSynth R79 HDR smoke test passed')


# Exercise the complete AI color path using ONNX Runtime on CPU. The production
# loader uses TensorRT; the substitution here tests pixel handling without GPU CI.
import numpy as np
import onnxruntime as ort
import vk_hdr_ai
model = Path(__file__).resolve().parents[1] / 'include/hdrtvnet/AGCM_LE.onnx'
options = ort.SessionOptions(); options.intra_op_num_threads = 2
session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])

def cpu_inference(clip, *args, **kwargs):
    def evaluate(n, f):
        frame = f
        pixels = np.stack([np.asarray(frame[p]) for p in range(3)])[None].astype(np.float32)
        prediction = session.run(None, {'input': pixels})[0][0]
        output = frame.copy()
        for p in range(3): np.copyto(np.asarray(output[p]), prediction[p])
        output.props['_Transfer'] = 16; output.props['_Primaries'] = 9
        output.props['_Matrix'] = 0; output.props['_Range'] = 1
        return output
    return core.std.ModifyFrame(clip, clip, evaluate)

vk_hdr_ai.load_model = cpu_inference
source = core.std.BlankClip(width=160, height=128, length=2, format=vs.YUV420P8, color=[126, 128, 128])
source = core.std.SetFrameProps(source, _Transfer=1, _Primaries=1, _Matrix=1, _Range=0)
ai_settings = dict(settings, method='hdrtvnet', aiExposure=0)
prepared = hdr.prepare_source(source, ai_settings, defaults)
converted = hdr.convert(prepared, ai_settings, model=str(model), cache='unused', builder='unused')
frame = converted.get_frame(0)
assert converted.format.id == vs.YUV420P10 and frame.props['_Transfer'] == 16
assert frame.props['_Primaries'] == 9 and frame.props['_Range'] == 0
hdr.sdr_preview(converted).get_frame(0)
print('HDRTVNet++ ONNX inference -> HDR trim -> 10-bit PQ -> SDR preview passed')

# Native subsampling survives AI source preparation; canonicalization performs
# the necessary upsampling in the same zimg conversion as RGB/color handling.
assert prepared.format.subsampling_w == source.format.subsampling_w
assert prepared.format.subsampling_h == source.format.subsampling_h
assert prepared.format.bits_per_sample == 16
for chroma in ('auto', 'off'):
    trial = dict(ai_settings, chroma=chroma)
    canonical = hdr.ai_input(hdr.prepare_source(source, trial, defaults), trial)
    pixels = canonical.get_frame(0)
    assert canonical.format.id == vs.RGBS
    assert pixels.props['_Transfer'] == 1 and pixels.props['_Primaries'] == 1
    assert all(np.isfinite(np.asarray(pixels[p])).all() for p in range(3))
    assert all(np.max(np.abs(np.asarray(pixels[p]) - np.asarray(pixels[0]))) < 1e-5 for p in range(3))
    legacy = core.resize.Spline36(hdr._linear_rgb(prepared, trial), format=vs.RGBS, primaries_s='709', transfer_s='709')
    old = legacy.get_frame(0)
    assert all(np.max(np.abs(np.asarray(pixels[p]) - np.asarray(old[p]))) < 2e-4 for p in range(3))
print('Fused AI color/chroma conversion matches neutral reference with both reconstruction settings')

# Validate actual Expr/zimg grading against the independent nits reference,
# including black, diffuse white, compressed highlights and very bright input.
for nits in (0, 203, 800, 4000):
    encoded = (pq_code(nits) - 64) / 876
    prediction = core.std.BlankClip(width=64, height=64, length=1, format=vs.RGBS, color=[encoded] * 3)
    prediction = core.std.SetFrameProps(prediction, _Transfer=16, _Primaries=9, _Matrix=0, _Range=1)
    grade = dict(ai_settings, referenceWhite=144, aiExposure=-.5, aiShoulder=.6, peakNits=850)
    result = hdr.finish_ai(prediction, grade).get_frame(0)
    expected = pq_code(hdr.ai_mapped_luminance(nits, grade))
    assert abs(result[0][0, 0] - expected) < 3, (nits, result[0][0, 0], expected)
print('Custom AI diffuse white, exposure, peak and highlight roll-off match numerical reference')

# Colored patches catch matrix/transfer/range mistakes hidden by neutral clips.
for matrix, primaries, transfer, full in ((1, 1, 1, 0), (6, 6, 6, 0), (1, 1, 13, 1)):
    patch = core.std.BlankClip(width=160, height=128, length=1, format=vs.YUV420P8, color=[126, 110, 150])
    patch = core.std.SetFrameProps(patch, _Transfer=transfer, _Primaries=primaries, _Matrix=matrix, _Range=full)
    prepared_patch = hdr.prepare_source(patch, ai_settings, defaults)
    props = prepared_patch.get_frame(0).props
    assert props['_Matrix'] == matrix and props['_Primaries'] == primaries and props['_Transfer'] == transfer
    assert props['_Range'] == full and prepared_patch.format.bits_per_sample == 16
    modern = hdr.ai_input(prepared_patch, ai_settings).get_frame(0)
    old_prepared = hdr.prepare_source(patch, dict(ai_settings, method='mathematical'), defaults)
    linear = hdr._linear_rgb(old_prepared, ai_settings)
    legacy = core.resize.Spline36(linear, format=vs.RGBS, primaries_s='709', transfer_s='709')
    legacy = core.std.Expr(legacy, 'x 0 max 1 min').get_frame(0)
    error = max(float(np.max(np.abs(np.asarray(modern[p]) - np.asarray(legacy[p])))) for p in range(3))
    assert error < 1e-3, (matrix, primaries, transfer, full, error)
print('Direct AI input matches legacy color reference for BT.709, BT.601 and full-range sRGB patches')
