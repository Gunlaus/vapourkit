import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildPipeFFmpegArgs } from './ffmpegPipeArgs';

// Explicit opt-in: real FFmpeg is a workstation prerequisite, not a CI fixture download.
describe.skipIf(process.env.VK_MEDIA_TESTS !== '1')('real encoding-preview isolation', () => {
  let dir: string;
  let source: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vk-preview-'));
    source = join(dir, 'source.mkv');
    const created = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24:d=4',
      '-c:v', 'rawvideo', '-threads:v', '1', '-allow_raw_vfw', '1', '-y', source], { encoding: 'utf8', timeout: 20000 });
    expect(created.status, created.stderr).toBe(0);
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('keeps every encoded frame identical and does not duplicate wall-time preview samples', () => {
    const hashes: string[] = [];
    for (const previewEnabled of [false, true]) {
      const output = join(dir, `${previewEnabled}.mkv`);
      const args = buildPipeFFmpegArgs({ inputPath: source, outputPath: output,
        metadata: { hasAudio: false, hasSubtitles: false, dar: null, duration: 4, startTime: 0, audioStreams: 0, subtitleStreams: 0 },
        outputInfo: { frames: 96, resolution: '160x90', fps: 24, fpsString: '24/1', pixelFormat: 'YUV420P8' },
        ffmpegConfig: { videoArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-threads:v', '1'] },
        audioTrim: { start: null, duration: null, exact: true }, previewEnabled, previewHeight: 180, previewFps: 0.1,
      });
      const encoded = spawnSync('ffmpeg', args, { input: readFileSync(source), timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
      expect(encoded.status, encoded.stderr.toString()).toBe(0);
      if (previewEnabled) {
        // Four seconds of media would produce duplicate previews if CFR filling remained.
        let frames = 0;
        for (let i = 0; i < encoded.stdout.length - 2; i++) if (encoded.stdout[i] === 255 && encoded.stdout[i + 1] === 216 && encoded.stdout[i + 2] === 255) frames++;
        expect(frames).toBe(1);
      } else expect(encoded.stdout.length).toBe(0);
      const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8', timeout: 10000 });
      expect(decoded.status, decoded.stderr).toBe(0);
      expect(decoded.stdout.split('\n').filter(line => line && !line.startsWith('#'))).toHaveLength(96);
      hashes.push(decoded.stdout);
    }
    expect(hashes[0]).toBe(hashes[1]);
  }, 45000);
});
