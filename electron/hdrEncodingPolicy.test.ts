import { describe, expect, it, vi } from 'vitest';
vi.mock('./configManager', () => ({ DEFAULT_FFMPEG_ARGS: '-c:v libx264' }));
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));
import { FFmpegSettingsManager } from './ffmpegSettingsManager';
import type { ConfigManager } from './configManager';
import { DEFAULT_ENCODING } from './encodingSettings';

describe('HDR encoding fail-closed policy', () => {
  it('does not turn invalid HDR encoding into the SDR fallback', async () => {
    const manager = { getEncodingSettings: () => DEFAULT_ENCODING, getFfmpegArgs: () => '-c:v libx264',
      getColorimetrySettings: () => ({ hdr: { enabled: true } }) } as unknown as ConfigManager;
    await expect(FFmpegSettingsManager.loadFFmpegConfig(manager)).rejects.toThrow(/HEVC or AV1/);
  });
});
