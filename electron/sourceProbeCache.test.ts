import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { cachedSourceProbe } from './sourceProbeCache';
import type { VideoProbe } from './videoUtils';

const value = (): VideoProbe => ({ display: { codec: 'h264' }, streams: { hasAudio: true, hasSubtitles: false, audioStreams: 1, subtitleStreams: 0, dar: null, duration: 1, startTime: 0 } });
let root: string;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-source-probe-')); });
afterAll(async () => { await fs.remove(root); });
async function file(name: string) { const file = path.join(root, name); await fs.writeFile(file, 'video'); return file; }

describe('source metadata reuse', () => {
  it('coalesces concurrent probes and gives each caller independent metadata', async () => {
    const source = await file('same'); const load = vi.fn(async () => value());
    const [a, b] = await Promise.all([cachedSourceProbe(source, '/ffmpeg', load), cachedSourceProbe(source, '/ffmpeg', load)]);
    a.display.codec = 'changed';
    expect(b.display.codec).toBe('h264');
    expect((await cachedSourceProbe(source, '/ffmpeg', load)).display.codec).toBe('h264');
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('invalidates a replaced source and a changed executable path', async () => {
    const source = await file('replaced'); const load = vi.fn(async () => value());
    await cachedSourceProbe(source, '/ffmpeg', load);
    await fs.writeFile(source, 'replacement video');
    await cachedSourceProbe(source, '/ffmpeg', load);
    await cachedSourceProbe(source, '/other/ffmpeg', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('retries unsuccessful probes', async () => {
    const source = await file('failure');
    const load = vi.fn(async (): Promise<VideoProbe> => ({ display: {}, streams: null }));
    await cachedSourceProbe(source, '/ffmpeg', load); await cachedSourceProbe(source, '/ffmpeg', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not cache an FFmpeg error parsed without any video stream', async () => {
    const source = await file('unreadable-video');
    const load = vi.fn(async (): Promise<VideoProbe> => ({ ...value(), display: {} }));
    await cachedSourceProbe(source, '/ffmpeg', load); await cachedSourceProbe(source, '/ffmpeg', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('expires metadata and bounds the number of retained entries', async () => {
    const source = await file('expired'); const load = vi.fn(async () => value());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
    try {
      await cachedSourceProbe(source, '/ffmpeg', load);
      clock.mockReturnValue(1400000);
      await cachedSourceProbe(source, '/ffmpeg', load);
      for (let i = 0; i < 33; i++) await cachedSourceProbe(await file(`bounded-${i}`), '/ffmpeg', async () => value());
      await cachedSourceProbe(source, '/ffmpeg', load);
      expect(load).toHaveBeenCalledTimes(3);
    } finally { clock.mockRestore(); }
  });
});
