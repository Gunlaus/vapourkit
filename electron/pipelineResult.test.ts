import { describe, expect, it } from 'vitest';
import { pipelineResult } from './pipelineResult';

describe('readable pipeline results', () => {
  it('uses total elapsed time rather than the encoder-only reported speed', () => {
    expect(pipelineResult(240, 12000)).toBe('Result: 240 frames · 12.00 seconds total · 20.00 FPS average');
  });
  it('does not fabricate a frame count or an infinite speed', () => {
    expect(pipelineResult(null, 12000)).toBe('Result: Frame count unavailable · 12.00 seconds total');
    expect(pipelineResult(0, 0)).toBe('Result: 0 frames · 0.00 seconds total');
  });
});
