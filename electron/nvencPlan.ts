import * as path from 'path';
import type { EncodingSettings } from './encodingSettings';
import type { Filter, ScriptConfig } from './scriptGenerator';

export interface NativeStream {
  codec_type: string; codec_name?: string; width?: number; height?: number;
  pix_fmt?: string; field_order?: string; color_transfer?: string; color_space?: string; color_range?: string;
  avg_frame_rate?: string; nb_frames?: string; nb_read_packets?: string; duration?: string;
}
export interface NativeProbe { streams: NativeStream[]; format?: { duration?: string } }
export interface NvencRequest {
  inputPath: string; outputPath: string; filters: Filter[]; encoding: EncodingSettings;
  defaultBackend?: string; processingFormat: string; colorimetry?: ScriptConfig['colorimetry'];
  segment?: { enabled: boolean; startFrame: number; endFrame: number }; benchmark?: boolean;
}
export function nativeModelFilter(request: NvencRequest): Filter {
  const fail = (message: string): never => { throw new Error(`NVEncC GPU path: ${message} Select VapourSynth execution in Settings → Processing for this workflow.`); };
  if (request.benchmark) fail('Use a normal encode for this experimental backend.');
  if (request.segment?.enabled) fail('The first version supports full videos; segment trimming is not yet supported.');
  const enabled = request.filters.filter(f => f.enabled);
  if (enabled.length !== 1 || enabled[0].filterType !== 'aiModel' || enabled[0].chain || !enabled[0].modelPath) fail('Choose exactly one AI model on the main chain, with no active VS filters or side chains.');
  const filter = enabled[0];
  if (filter.modelType === 'vsr') fail('Choose a single-image RGB model; temporal models are not yet supported.');
  if ((filter.backend && filter.backend !== 'auto' ? filter.backend : request.defaultBackend ?? 'tensorrt') !== 'tensorrt') fail('Choose the TensorRT inference backend.');
  if (request.encoding.mode !== 'simple' || request.encoding.simple.encoder !== 'nvidia' || request.encoding.simple.codec === 'prores') fail('Use Simple output settings with NVIDIA H.264, HEVC, or AV1 encoding. Advanced FFmpeg arguments cannot be translated safely.');
  if (!['vs.YUV420P8', 'vs.YUV420P10'].includes(request.processingFormat)) fail('Choose YUV420P8 or YUV420P10 processing output.');
  if (request.colorimetry && (request.colorimetry.defaultMatrix !== '709' || request.colorimetry.defaultPrimaries !== '709' || request.colorimetry.defaultTransfer !== '709' || (request.colorimetry.overwriteMatrix && !request.colorimetry.matrix709))) fail('This prototype supports BT.709 color processing only.');
  if (!['.mkv', '.mp4', '.mov'].includes(path.extname(request.outputPath).toLowerCase())) fail('Choose MKV, MP4 or MOV output.');
  if (path.resolve(request.inputPath).toLowerCase() === path.resolve(request.outputPath).toLowerCase()) fail('Choose a different output path from the source.');
  return filter;
}

export function sourceVideo(probe: NativeProbe): NativeStream {
  const video = probe.streams.find(s => s.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('NVEncC: no readable video stream in the source.');
  if (!['yuv420p', 'yuv420p10le'].includes(video.pix_fmt ?? '') || !['progressive', 'unknown', undefined].includes(video.field_order)) throw new Error('NVEncC GPU path currently requires progressive 8/10-bit YUV420 video. Use VapourSynth execution for this source.');
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? '')) throw new Error('HDR source handling is not enabled in this experimental backend. Use VapourSynth execution.');
  if (video.color_range === 'pc' || ![undefined, 'unknown', 'bt709'].includes(video.color_space) || ![undefined, 'unknown', 'bt709'].includes(video.color_transfer)) throw new Error('This prototype requires limited-range BT.709 SDR input. Use VapourSynth execution for other color spaces.');
  return video;
}

export function selectedOrdinals(probe: NativeProbe, type: 'audio' | 'subtitle', selected?: number[]): number[] {
  const count = probe.streams.filter(s => s.codec_type === type).length;
  return selected === undefined ? Array.from({ length: count }, (_, i) => i) : selected.filter(i => i < count);
}

/** NVEncC uses one-based per-type track numbers; Vapourkit stores zero-based ordinals. */
export function nvencArgs(request: NvencRequest, probe: NativeProbe, modelPath: string, cachePath: string, precision: 'fp16' | 'fp32', outputPath: string, device = 0): string[] {
  nativeModelFilter(request);
  const video = sourceVideo(probe);
  const simple = request.encoding.simple;
  const matrix = request.colorimetry?.defaultMatrix === '170m' ? 'smpte170m' : 'bt709';
  const inputMatrix = request.colorimetry?.overwriteMatrix
    ? request.colorimetry.matrix709 ? 'bt709' : 'smpte170m'
    : ({ bt709: 'bt709', smpte170m: 'smpte170m', bt470bg: 'bt470bg' }[video.color_space ?? ''] ?? matrix);
  // The comma-delimited filter parameter has its own quoting, separate from argv.
  const quote = (value: string) => {
    if (/["\r\n]/.test(value)) throw new Error('NVEncC model/cache paths cannot contain quotes or newlines.');
    return `"${value}"`;
  };
  const args = ['--avhw', '--device', String(device), '-i', request.inputPath, '-o', outputPath,
    '--codec', simple.codec === 'h265' ? 'hevc' : simple.codec, '--preset', simple.preset.toLowerCase(),
    '--tune', 'hq', '--multipass', 'none', '--lookahead', '0',
    '--output-depth', request.processingFormat === 'vs.YUV420P10' ? '10' : '8',
    '--avsync', 'vfr', '--colormatrix', 'bt709', '--colorprim', 'bt709', '--transfer', 'bt709', '--colorrange', 'limited',
    '--vpp-onnx', `model=${quote(modelPath)},provider=tensorrt,prec=${precision},colormatrix=${inputMatrix},colormatrix_out=bt709,colorrange=${video.color_range === 'pc' ? 'full' : 'limited'},frames=1`,
    '--vpp-onnx-cache-dir', cachePath, '--log-level', 'info'];
  if (simple.rateControl === 'bitrate') args.push('--vbr', String(Math.round((simple.bitrateMbps ?? 8) * 1000)));
  else args.push('--qvbr', String(simple.quality));
  if (simple.maxBitrateMbps) args.push('--max-bitrate', String(Math.round(simple.maxBitrateMbps * 1000)), '--vbv-bufsize', String(Math.round(simple.maxBitrateMbps * 2000)));
  if (simple.keyframeInterval) args.push('--gop-len', String(simple.keyframeInterval));
  const audio = simple.audioCodec === 'none' ? [] : selectedOrdinals(probe, 'audio', request.encoding.audioTracks);
  const subtitles = selectedOrdinals(probe, 'subtitle', request.encoding.subtitleTracks);
  if (audio.length) {
    if (!simple.audioCodec || simple.audioCodec === 'copy') args.push('--audio-copy', audio.map(i => i + 1).join(','));
    else for (const i of audio) {
      args.push('--audio-codec', `${i + 1}?${simple.audioCodec}`);
      if (simple.audioCodec !== 'flac') args.push('--audio-bitrate', `${i + 1}?${simple.audioBitrateKbps ?? 192}`);
      if (simple.audioChannels) args.push('--audio-stream', `${i + 1}?:${({ 1: 'mono', 2: 'stereo', 6: '5.1' } as Record<number, string>)[simple.audioChannels]}`);
    }
    args.push('--audio-metadata', 'copy');
  }
  if (subtitles.length) {
    if (path.extname(outputPath).toLowerCase() !== '.mkv') throw new Error('Use MKV output to retain subtitles in the NVEncC GPU path, or remove subtitles in Output settings.');
    args.push('--sub-copy', subtitles.map(i => i + 1).join(','), '--sub-metadata', 'copy', '--attachment-copy');
  }
  args.push('--metadata', simple.copyMetadata === false ? 'clear' : 'copy');
  if (simple.copyMetadata !== false) args.push('--video-metadata', 'copy', '--chapter-copy');
  return args;
}

export function verifyNativeOutput(probe: NativeProbe, result: NativeProbe, request: NvencRequest): void {
  const video = result.streams.filter(s => s.codec_type === 'video');
  if (video.length !== 1 || !video[0].width || !video[0].height) throw new Error('NVEncC produced no readable output video.');
  const codec = request.encoding.simple.codec === 'h265' ? 'hevc' : request.encoding.simple.codec;
  if (video[0].codec_name !== codec) throw new Error('NVEncC output codec does not match the selected settings. Output was not published.');
  if (video[0].pix_fmt !== (request.processingFormat === 'vs.YUV420P10' ? 'yuv420p10le' : 'yuv420p')) throw new Error('NVEncC output pixel format does not match the selected bit depth. Output was not published.');
  const audio = request.encoding.simple.audioCodec === 'none' ? [] : selectedOrdinals(probe, 'audio', request.encoding.audioTracks);
  const subtitles = selectedOrdinals(probe, 'subtitle', request.encoding.subtitleTracks);
  for (const [type, expected] of [['audio', audio], ['subtitle', subtitles]] as const) {
    if (result.streams.filter(s => s.codec_type === type).length !== expected.length) throw new Error(`NVEncC did not preserve the selected ${type} tracks. Output was not published; use VapourSynth execution and include the item log in your report.`);
  }
  if (subtitles.length && result.streams.filter(s => s.codec_type === 'attachment').length !== probe.streams.filter(s => s.codec_type === 'attachment').length) throw new Error('NVEncC did not preserve the source subtitle attachments. Output was not published.');
  const frames = Number(probe.streams.find(s => s.codec_type === 'video')?.nb_frames);
  const produced = Number(video[0].nb_frames ?? video[0].nb_read_packets);
  if (frames > 0 && produced > 0 && frames !== produced) throw new Error(`NVEncC output frame count differs from the source (${produced} versus ${frames}). Output was not published.`);
}
