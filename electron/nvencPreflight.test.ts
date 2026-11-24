import { beforeEach, describe, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => vi.fn());
vi.mock('./encodingSupport', () => ({ checkNvencEncoder: probe }));
import { nvencPreflight } from './nvencPreflight';
beforeEach(() => probe.mockReset());
describe('advisory NVENC preflight', () => {
  it('allows explicitly continuing after a failed default-options test', async () => {
    probe.mockResolvedValue({ available: false, category: 'unknown', message: 'Default configuration failed' });
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(nvencPreflight('ffmpeg','hevc_nvenc','vs.YUV420P8',() => false,confirm)).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
  });
  it('does not run a render after declining the warning', async () => {
    probe.mockResolvedValue({ available: false });
    await expect(nvencPreflight('ffmpeg','av1_nvenc','vs.YUV420P8',() => false,async () => false)).rejects.toThrow('Canceled');
  });
  it('does not show a failed-probe prompt after cancellation', async () => {
    probe.mockResolvedValue({ available: false });
    const confirm = vi.fn();
    await expect(nvencPreflight('ffmpeg','av1_nvenc','vs.YUV420P8',() => true,confirm)).rejects.toThrow('Canceled');
    expect(confirm).not.toHaveBeenCalled();
  });
  it('starts normally after a successful probe', async () => {
    probe.mockResolvedValue({ available: true });
    const confirm = vi.fn();
    await nvencPreflight('ffmpeg','h264_nvenc','vs.YUV420P8',() => false,confirm);
    expect(confirm).not.toHaveBeenCalled();
  });
});
