"""Managed SDR -> PQ conversion. Deterministic, bounded, no learned synthesis.

RGB values remain floating point until the final dither. The fixed luminance
curve is identical on every frame, so it introduces no exposure pumping.
It is a baseline for comparison, not a claim to recover clipped scene detail.
"""
import math


def validate(settings):
    peak = float(settings['peakNits'])
    white = float(settings['referenceWhite'])
    strength = float(settings['strength'])
    if not (math.isfinite(peak) and 400 <= peak <= 4000 and
            math.isfinite(white) and 80 <= white <= 300 and white < peak and
            math.isfinite(strength) and 0 <= strength <= 1):
        raise ValueError('Invalid HDR peak, reference white or expansion strength.')
    return peak, white, strength


def mapped_luminance(y, settings):
    """Reference implementation in nits, also used by offline curve tests."""
    peak, white, strength = validate(settings)
    y = min(1.0, max(0.0, y))
    return white * y + (peak - white) * strength * y ** 5


def prepare_source(clip, settings, defaults):
    import vapoursynth as vs
    core = vs.core
    frame = clip.get_frame(0)
    props = frame.props
    if props.get('_Transfer') in (16, 18):
        raise ValueError('SDR-to-HDR received an HDR source. Disable HDR conversion for PQ/HLG input.')
    if props.get('_FieldBased', 0):
        raise ValueError('SDR-to-HDR currently requires progressive input. Deinterlace before importing this source.')
    if clip.format is None:
        raise ValueError('HDR conversion requires a constant input format.')
    matrix_default = 1 if defaults['defaultMatrix'] == '709' else 6
    primaries_default = 1 if defaults['defaultPrimaries'] == '709' else 6
    codes = {'709': 1, '470bg': 5, '170m': 6}
    matrix = codes.get(settings.get('sourceMatrix'), props.get('_Matrix', matrix_default))
    primaries = codes.get(settings.get('sourcePrimaries'), props.get('_Primaries', primaries_default))
    transfer = {'709': 1, 'srgb': 13, 'gamma24': 1}.get(settings.get('sourceTransfer'), props.get('_Transfer', 1))
    if matrix == 2: matrix = matrix_default
    if primaries == 2: primaries = primaries_default
    if transfer == 2: transfer = 1
    if matrix not in (0, 1, 5, 6) or primaries not in (1, 5, 6) or transfer not in (1, 6, 13):
        raise ValueError('This HDR baseline supports BT.709/BT.601 SDR or sRGB. Correct source color metadata first.')
    color_range = 1 - props['_Range'] if '_Range' in props else props.get('_ColorRange', 0 if clip.format.color_family == vs.RGB else 1)
    color_range = {'limited': 1, 'full': 0}.get(settings.get('sourceRange'), color_range)
    if color_range not in (0, 1):
        raise ValueError('Unrecognized source color range for HDR conversion.')
    tags = dict(_Primaries=primaries, _Transfer=transfer, _Range=1 - color_range)
    if clip.format.color_family != vs.RGB: tags['_Matrix'] = matrix
    print(f'[hdr-source] matrix={matrix}, primaries={primaries}, transfer={transfer}, range={color_range}; missing SDR tags use configured defaults.')
    clip = core.std.SetFrameProps(clip, **tags)
    if settings['chroma'] == 'auto' and clip.format.color_family == vs.YUV and (
            clip.format.subsampling_w or clip.format.subsampling_h):
        # Let zimg use the signaled chroma location; use left only if absent.
        if '_ChromaLocation' not in props:
            clip = core.std.SetFrameProps(clip, _ChromaLocation=0)
        clip = core.resize.Spline36(clip, format=vs.YUV444P16, range_s='full' if color_range == 0 else 'limited', dither_type='none')
    if clip.format.color_family == vs.RGB:
        clip = core.resize.Spline36(clip, format=vs.YUV444P16, matrix_s='709', dither_type='none')
    elif clip.format.bits_per_sample != 16 or clip.format.sample_type != vs.INTEGER:
        clip = core.resize.Point(clip, format=clip.format.replace(sample_type=vs.INTEGER, bits_per_sample=16).id, range_s='full' if color_range == 0 else 'limited', dither_type='none')
    return clip


def _linear_rgb(clip, settings):
    import vapoursynth as vs
    core = vs.core
    # The regular chain is SDR; its output must not unexpectedly become HDR.
    frame = clip.get_frame(0)
    if frame.props.get('_Transfer') in (16, 18):
        raise ValueError('A filter already produced HDR. Remove it or disable SDR-to-HDR.')
    transfer = settings['sourceTransfer']
    kwargs = {} if transfer == 'auto' else {'transfer_in_s': '709' if transfer == 'gamma24' else transfer}
    if clip.format.color_family != vs.RGB:
        kwargs['matrix_in'] = frame.props.get('_Matrix', 1)
    if transfer == 'gamma24':
        rgb = core.resize.Spline36(clip, format=vs.RGBS, **kwargs)
        rgb = core.std.Expr(rgb, 'x 0 max 1 min 2.4 pow')
        rgb = core.std.SetFrameProps(rgb, _Transfer=8, _Matrix=0, _Range=1)
        return core.resize.Spline36(rgb, format=vs.RGBS, primaries_s='2020', transfer_s='linear')
    return core.resize.Spline36(clip, format=vs.RGBS, primaries_s='2020', transfer_s='linear', **kwargs)


def convert(clip, settings):
    import vapoursynth as vs
    core = vs.core
    peak, white, strength = validate(settings)
    rgb = _linear_rgb(clip, settings)
    rgb = core.std.Expr(rgb, 'x 0 max 1 min')
    r, g, b = [core.std.ShufflePlanes(rgb, i, vs.GRAY) for i in range(3)]
    # BT.2020 linear-light luminance. A common gain preserves chromaticity.
    y = core.std.Expr([r, g, b], 'x 0.2627 * y 0.6780 * + z 0.0593 * +')
    maximum = core.std.Expr([r, g, b], 'x y max z max 0.000001 max')
    gain = core.std.Expr([y, maximum],
        f'{white / 100.0} {((peak - white) * strength) / 100.0} x 4 pow * + '
        f'{peak / 100.0} y / min')
    channels = [core.std.Expr([c, gain], 'x y *') for c in (r, g, b)]
    expanded = core.std.ShufflePlanes(channels, [0, 0, 0], vs.RGB)
    expanded = core.std.SetFrameProps(expanded, _Matrix=0, _Transfer=8, _Primaries=9, _Range=1)
    # Linear value 1 represents 100 nits. zimg handles the actual PQ encoding.
    pq = core.resize.Spline36(expanded, format=vs.YUV420P10,
        transfer_s='st2084', primaries_s='2020', matrix_s='2020ncl',
        range_s='limited', nominal_luminance=100, dither_type='error_diffusion')
    return core.std.SetFrameProps(pq, _Matrix=9, _Transfer=16, _Primaries=9, _Range=0)


def sdr_preview(clip):
    """Navigation preview only; the encoded output remains PQ HDR."""
    import vapoursynth as vs
    core = vs.core
    rgb = core.resize.Spline36(clip, format=vs.RGBS, transfer_s='linear', nominal_luminance=100)
    r, g, b = [core.std.ShufflePlanes(rgb, i, vs.GRAY) for i in range(3)]
    y = core.std.Expr([r, g, b], 'x 0.2627 * y 0.6780 * + z 0.0593 * +')
    channels = [core.std.Expr([c, y], 'x y 1 + /') for c in (r, g, b)]
    mapped = core.std.ShufflePlanes(channels, [0, 0, 0], vs.RGB)
    mapped = core.std.SetFrameProps(mapped, _Matrix=0, _Transfer=8, _Primaries=9, _Range=1)
    return core.resize.Spline36(mapped, format=vs.YUV444P16, primaries_s='709',
        transfer_s='709', matrix_s='709', dither_type='error_diffusion')
