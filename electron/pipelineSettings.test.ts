import { describe, expect, it } from 'vitest';
import { pipelineSettingsSchema } from './pipelineSettings';

describe('performance settings migration and validation', () => {
  it('adds graph replay without replacing saved preview settings or runtime scheduling', () => {
    expect(pipelineSettingsSchema.parse({ previewHeight: 360, previewFps: 2 })).toEqual({
      previewHeight: 360, previewFps: 2, trtCudaGraphs: true, frameRequests: 0, cpuThreads: 0, cacheMiB: 0,
    });
  });
  it.each([{ frameRequests: 33 }, { cpuThreads: -1 }, { cacheMiB: 1.5 }, { trtCudaGraphs: 'yes' }])('rejects invalid values %j', value => {
    expect(pipelineSettingsSchema.safeParse(value).success).toBe(false);
  });
});

it('discards the old manual execution selector when loading saved settings', () => {
  expect(pipelineSettingsSchema.parse({ executionBackend: 'nvencc' })).not.toHaveProperty('executionBackend');
});
