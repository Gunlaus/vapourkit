vi.mock('./logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
import { verifyHdrOutput } from './hdrOutput';
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildPipeFFmpegArgs } from './ffmpegPipeArgs';
import { hdrEncodingArgs } from './hdrSettings';
import { DEFAULT_ENCODING } from './encodingSettings';

describe.skipIf(process.env.VK_MEDIA_TESTS !== '1')('HDR pipe and encoder integration', () => {
  it('writes matching 10-bit PQ tags and keeps the main encode unchanged by SDR preview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vk-hdr-'));
    try {
      const source = join(dir, 'pq-fixture.mkv');
      const create = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24:d=0.5',
        '-pix_fmt', 'yuv420p10le', '-c:v', 'ffv1', '-threads:v', '1', '-y', source], { timeout: 20000 });
      expect(create.status, create.stderr?.toString()).toBe(0);
      const hashes: string[] = [];
      for (const previewEnabled of [false, true]) {
        const output = join(dir, `hdr-${previewEnabled}.mkv`);
        const args = buildPipeFFmpegArgs({ inputPath: source, outputPath: output,
          outputInfo: { frames: 12, resolution: '160x90', fps: 24, fpsString: '24/1', pixelFormat: 'YUV420P10' },
          metadata: { hasAudio: false, hasSubtitles: false, dar: null, duration: .5, startTime: 0, audioStreams: 0, subtitleStreams: 0 },
          ffmpegConfig: { hdr: true, videoArgs: hdrEncodingArgs(DEFAULT_ENCODING, '-c:v libx265 -preset ultrafast -crf 20 -threads:v 1') },
          audioTrim: { start: null, duration: null, exact: true }, previewEnabled, previewHeight: 180,
        });
        const result = spawnSync('ffmpeg', args, { input: readFileSync(source), timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
        expect(result.status, result.stderr?.toString()).toBe(0);
        await verifyHdrOutput(output, 'ffprobe', new AbortController().signal);
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' });
        expect(probe.status).toBe(0);
        expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({ pix_fmt: 'yuv420p10le', profile: 'Main 10',
          color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_range: 'tv' });
        const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'framemd5', '-'], { encoding: 'utf8', timeout: 10000 });
        expect(decoded.status, decoded.stderr).toBe(0); hashes.push(decoded.stdout);
        if (previewEnabled) expect(result.stdout.length).toBeGreaterThan(0);
      }
      expect(hashes[0]).toBe(hashes[1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 50000);
});
