import { z } from 'zod';
import { splitArgs, type EncodingSettings } from './encodingSettings';

export const hdrSettingsSchema = z.object({
  method: z.enum(['mathematical', 'hdrtvnet']).optional(),
  aiExposure: z.number().finite().min(-2).max(2).optional(),
  enabled: z.boolean().default(false),
  preset: z.enum(['natural', 'animation', 'custom']).default('natural'),
  peakNits: z.number().finite().min(400).max(4000).default(1000),
  referenceWhite: z.number().finite().min(80).max(300).default(203),
  strength: z.number().finite().min(0).max(1).default(0.35),
  chroma: z.enum(['auto', 'off']).default('auto'),
  sourceMatrix: z.enum(['auto', '709', '170m', '470bg']).optional(),
  sourcePrimaries: z.enum(['auto', '709', '170m', '470bg']).optional(),
  sourceRange: z.enum(['auto', 'limited', 'full']).optional(),
  sourceTransfer: z.enum(['auto', '709', 'srgb', 'gamma24']).default('auto'),
}).refine(value => value.referenceWhite < value.peakNits, 'HDR reference white must be below the target peak.');
export type HdrSettings = z.infer<typeof hdrSettingsSchema>;
export const DEFAULT_HDR = hdrSettingsSchema.parse({});

/** Deliberate visible codec change when the user enables HDR in simple mode. */
export function hdrCompatibleEncoding(value: EncodingSettings): EncodingSettings {
  if (value.mode !== 'simple' || ['av1', 'h265'].includes(value.simple.codec)) return value;
  return { ...value, simple: { ...value.simple, codec: 'h265', quality: 20, tune: 'none' } };
}

const HDR_TAGS = ['-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv'];
const SDR_SET_PARAMS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';

/** Reject unsafe user transforms; never fall back to SDR encoding on failure. */
export function hdrEncodingArgs(encoding: EncodingSettings, resolved: string): string[] {
  const args = splitArgs(resolved);
  const codecIndex = args.findIndex(arg => ['-c:v', '-codec:v', '-vcodec', '-c:v:0'].includes(arg));
  const codec = args[codecIndex + 1];
  if (codecIndex < 0 || !['libx265', 'libsvtav1', 'hevc_nvenc', 'av1_nvenc', 'hevc_qsv', 'av1_qsv', 'hevc_amf', 'av1_amf'].includes(codec)) {
    throw new Error('HDR output requires HEVC or AV1 encoding. Choose HEVC/AV1 in Output settings.');
  }
  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '-vf' && args[i + 1] === SDR_SET_PARAMS) { i++; continue; }
    if (/^-(?:vf(?::|$)|vfilters|c$|codec$|filter|filter_complex|lavfi|c:v|codec:v|vcodec|pix_fmt|profile:v|color|colorspace|x265-params|svtav1-params|bsf:v|attach|metadata)/.test(flag)
        && !(i === codecIndex)) {
      throw new Error(`HDR manages output color and format. Remove conflicting Advanced option ${flag}, or use Simple encoding.`);
    }
    cleaned.push(flag);
  }
  // Main 10 is required for HEVC; AV1's Main profile includes 10-bit 4:2:0.
  if (codec.startsWith('hevc') || codec === 'libx265') cleaned.push('-profile:v', 'main10');
  else if (encoding.mode === 'simple') cleaned.push('-profile:v', 'main');
  return [...cleaned, ...HDR_TAGS];
}
