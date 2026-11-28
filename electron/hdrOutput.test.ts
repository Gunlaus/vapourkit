vi.mock('./logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
import { expect, it, vi } from 'vitest';
import { assertHdrStream } from './hdrOutput';

it('rejects a successful encode that silently returned SDR tags or 8-bit pixels', () => {
  const valid = { codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084',
    color_primaries: 'bt2020', color_space: 'bt2020nc', color_range: 'tv' };
  expect(() => assertHdrStream(valid)).not.toThrow();
  for (const patch of [{ pix_fmt: 'yuv420p' }, { color_transfer: 'bt709' }, { color_range: 'pc' }, { codec_name: 'h264' }]) {
    expect(() => assertHdrStream({ ...valid, ...patch })).toThrow(/HDR output verification failed/);
  }
});
