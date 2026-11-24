import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshSessionOnStartup } from './startupSession';
afterEach(() => vi.unstubAllGlobals());
describe('startup session preference', () => {
  it('preserves restoration unless fresh startup was explicitly selected', () => {
    for (const saved of [null, 'false', 'true']) {
      vi.stubGlobal('localStorage', { getItem: () => saved });
      expect(freshSessionOnStartup()).toBe(saved === 'true');
    }
  });
  it('keeps restoration if storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(freshSessionOnStartup()).toBe(false);
  });
});
