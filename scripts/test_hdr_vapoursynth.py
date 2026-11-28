"""Opt-in target-runtime smoke test; uses synthetic CPU clips, no GPU/models."""
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
