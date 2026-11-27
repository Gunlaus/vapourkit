import { describe, expect, it } from 'vitest';
import { nativeModelFilter, nvencArgs, selectedOrdinals, sourceVideo, verifyNativeOutput, type NativeProbe, type NvencRequest } from './nvencPlan';

function request(changes: Partial<NvencRequest> = {}): NvencRequest {
  return { inputPath: 'D:/input.mkv', outputPath: 'D:/output.mkv', defaultBackend: 'tensorrt', processingFormat: 'vs.YUV420P8',
    filters: [{ id: 'ai', enabled: true, filterType: 'aiModel', code: '', preset: 'AI Model', order: 0, modelPath: 'D:/model_fp16.engine' }],
    encoding: { mode: 'simple', customArgs: '', simple: { codec: 'av1', encoder: 'nvidia', preset: 'p6', quality: 25 } }, ...changes };
}
const source: NativeProbe = { streams: [
  { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', field_order: 'progressive', color_space: 'bt709', color_transfer: 'bt709', color_range: 'tv', nb_frames: '100' },
  { codec_type: 'audio', codec_name: 'aac' }, { codec_type: 'audio', codec_name: 'flac' },
  { codec_type: 'subtitle', codec_name: 'ass' }, { codec_type: 'subtitle', codec_name: 'subrip' }, { codec_type: 'attachment', codec_name: 'ttf' },
] };
const build = (r = request(), output = 'D:/stage.mkv') => nvencArgs(r, source, 'D:/model dir,one/model.onnx', 'D:/cache', 'fp16', output, 2);
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('native GPU plan eligibility', () => {
  it('accepts a single main-chain image model', () => { expect(nativeModelFilter(request()).id).toBe('ai'); });
  it.each([
    { filters: [] }, { benchmark: true }, { segment: { enabled: true, startFrame: 0, endFrame: 100 } },
    { processingFormat: 'vs.RGBS' }, { outputPath: 'D:/input.mkv' }, { defaultBackend: 'directml' },
  ] as Partial<NvencRequest>[])('explains unsupported workflows %j', changes => {
    expect(() => nativeModelFilter(request(changes))).toThrow(/VapourSynth execution/);
  });
  it('does not drop an active filter or side chain', () => {
    const r = request(); r.filters.push({ id: 'blur', filterType: 'custom', enabled: true, order: 1, code: 'clip=blur(clip)', preset: 'Blur' });
    expect(() => nativeModelFilter(r)).toThrow(/no active VS filters/);
    r.filters = [{ ...r.filters[0], chain: 'reference' }];
    expect(() => nativeModelFilter(r)).toThrow(/side chains/);
  });
  it('refuses advanced argument translation and CPU encoding', () => {
    const r = request(); r.encoding.mode = 'advanced';
    expect(() => nativeModelFilter(r)).toThrow(/Advanced FFmpeg/);
    r.encoding.mode = 'simple'; r.encoding.simple.encoder = 'software';
    expect(() => nativeModelFilter(r)).toThrow(/NVIDIA/);
  });
  it.each([{ pix_fmt: 'yuv444p' }, { field_order: 'tt' }, { color_range: 'pc' }, { color_transfer: 'smpte2084' }, { color_space: 'bt2020nc' }])('rejects unsupported source colors/layouts %j', change => {
    expect(() => sourceVideo({ streams: [{ ...source.streams[0], ...change }] })).toThrow();
  });
});

describe('native command settings', () => {
  it('keeps model precision, preset, codec, output depth and explicit GPU', () => {
    const args = build();
    expect(value(args, '--device')).toBe('2'); expect(value(args, '--codec')).toBe('av1');
    expect(value(args, '--preset')).toBe('p6'); expect(value(args, '--qvbr')).toBe('25');
    expect(value(args, '--output-depth')).toBe('8'); expect(value(args, '--avsync')).toBe('vfr');
    expect(value(args, '--vpp-onnx')).toContain('model="D:/model dir,one/model.onnx",provider=tensorrt,prec=fp16');
    expect(value(args, '--vpp-onnx')).toContain('colormatrix_out=bt709');
  });
  it('maps bitrate and keyframe controls without inventing defaults', () => {
    const r = request(); Object.assign(r.encoding.simple, { codec: 'h265', rateControl: 'bitrate', bitrateMbps: 12, maxBitrateMbps: 20, keyframeInterval: 240 }); r.processingFormat = 'vs.YUV420P10';
    const args = build(r);
    expect(value(args, '--codec')).toBe('hevc'); expect(value(args, '--vbr')).toBe('12000');
    expect(value(args, '--max-bitrate')).toBe('20000'); expect(value(args, '--vbv-bufsize')).toBe('40000');
    expect(value(args, '--gop-len')).toBe('240'); expect(value(args, '--output-depth')).toBe('10');
    expect(args).not.toContain('--qvbr');
  });
  it('keeps all tracks by default and copies subtitle attachments', () => {
    const args = build(); expect(value(args, '--audio-copy')).toBe('1,2');
    expect(value(args, '--sub-copy')).toBe('1,2'); expect(args).toContain('--attachment-copy');
  });
  it('uses one-based ordinals and does not re-enable absent batch selections', () => {
    const r = request(); r.encoding.audioTracks = [1, 9]; r.encoding.subtitleTracks = [];
    const args = build(r); expect(value(args, '--audio-copy')).toBe('2'); expect(args).not.toContain('--sub-copy');
    expect(selectedOrdinals(source, 'audio', [9])).toEqual([]);
  });
  it('preserves audio conversion controls and explicit removal', () => {
    const r = request(); r.encoding.audioTracks = [1]; Object.assign(r.encoding.simple, { audioCodec: 'aac', audioBitrateKbps: 256, audioChannels: 2 });
    const args = build(r); expect(value(args, '--audio-codec')).toBe('2?aac');
    expect(value(args, '--audio-bitrate')).toBe('2?256'); expect(value(args, '--audio-stream')).toBe('2?:stereo');
    r.encoding.simple.audioCodec = 'none'; expect(build(r)).not.toContain('--audio-copy'); expect(build(r)).not.toContain('--audio-codec');
  });
  it('does not silently drop subtitles in an incompatible output container', () => {
    expect(() => build(request(), 'D:/stage.mp4')).toThrow(/MKV/);
    const r = request(); r.encoding.subtitleTracks = [];
    expect(build(r, 'D:/stage.mp4')).toContain('D:/stage.mp4');
  });
  it('rejects unrepresentable filter paths', () => {
    expect(() => nvencArgs(request(), source, 'bad"path.onnx', '/cache', 'fp32', '/stage.mkv')).toThrow(/quotes/);
  });
});

describe('native output publication checks', () => {
  it('accepts the selected streams and rejects missing audio, subtitles, fonts or frames', () => {
    const output = { streams: source.streams.map(s => s.codec_type === 'video' ? { ...s, codec_name: 'av1', width: 3840, height: 2160 } : s) };
    expect(() => verifyNativeOutput(source, output, request())).not.toThrow();
    for (const type of ['audio', 'subtitle', 'attachment', 'video']) {
      expect(() => verifyNativeOutput(source, { streams: output.streams.filter(s => s.codec_type !== type) }, request())).toThrow();
    }
    expect(() => verifyNativeOutput(source, { streams: output.streams.map(s => s.codec_type === 'video' ? { ...s, nb_frames: '99' } : s) }, request())).toThrow(/frame count/);
    expect(() => verifyNativeOutput(source, source, request())).toThrow(/codec/);
  });
});
