import { describe, expect, it } from 'vitest';
import { DEFAULT_HDR, hdrCompatibleEncoding, hdrEncodingArgs, hdrSettingsSchema } from './hdrSettings';
import { DEFAULT_ENCODING, resolveEncodingArgs } from './encodingSettings';

describe('managed HDR output contract', () => {
  it('migrates old workflows with HDR off and rejects malformed brightness settings', () => {
    expect(hdrSettingsSchema.parse({}).enabled).toBe(false);
    for (const peakNits of [NaN, Infinity, -1, 10000]) expect(hdrSettingsSchema.safeParse({ peakNits }).success).toBe(false);
    expect(hdrSettingsSchema.safeParse({ strength: 2 }).success).toBe(false);
  });
  it('switches incompatible simple encoding visibly without mutating the source', () => {
    const next = hdrCompatibleEncoding(DEFAULT_ENCODING);
    expect(next.simple.codec).toBe('h265');
    expect(DEFAULT_ENCODING.simple.codec).toBe('h264');
    const args = hdrEncodingArgs(next, resolveEncodingArgs(next));
    expect(args).toContain('main10');
    expect(args).toContain('yuv420p10le');
    expect(args).toContain('smpte2084');
    expect(args).toContain('bt2020nc');
    expect(args.join(' ')).not.toContain('bt709');
  });
  it('lets each AV1 encoder select Main from the enforced 10-bit format', () => {
    for (const codec of ['av1_nvenc', 'libsvtav1', 'av1_qsv', 'av1_amf']) {
      for (const mode of ['simple', 'advanced'] as const) {
        const args = hdrEncodingArgs({ ...DEFAULT_ENCODING, mode }, `-c:v ${codec} -b:v 0`);
        expect(args).not.toContain('-profile:v');
        expect(args).toContain('yuv420p10le');
        expect(args).toContain('smpte2084');
      }
    }
    expect(hdrSettingsSchema.parse({ peakNits: 850 }).peakNits).toBe(850);
    for (const aiShoulder of [.39, .96, NaN]) expect(hdrSettingsSchema.safeParse({ aiShoulder }).success).toBe(false);
  });
  it('accepts audio settings but refuses video overrides that invalidate the contract', () => {
    const encoding = { ...DEFAULT_ENCODING, mode: 'advanced' as const };
    expect(hdrEncodingArgs(encoding, '-c:v libsvtav1 -crf 25 -c:a aac -b:a 192k')).toContain('aac');
    for (const suffix of ['-pix_fmt yuv420p', '-vf scale=1280:720', '-color_trc bt709', '-c:v copy', '-c copy', '-x265-params colorprim=bt709']) {
      expect(() => hdrEncodingArgs(encoding, '-c:v libx265 ' + suffix)).toThrow();
    }
    expect(() => hdrEncodingArgs(DEFAULT_ENCODING, resolveEncodingArgs(DEFAULT_ENCODING))).toThrow(/HEVC or AV1/);
    expect(DEFAULT_HDR.enabled).toBe(false);
  });
});
