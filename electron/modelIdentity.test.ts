import { describe, expect, it } from 'vitest';
import { modelMetadataKey } from './modelIdentity';
describe('model package metadata identities', () => {
  it('keeps root model metadata backwards-compatible', () => {
    expect(modelMetadataKey('C:/app/models/anime.onnx','C:/app/models')).toBe('anime');
    expect(modelMetadataKey('/app/models/anime.engine','/app/models')).toBe('anime');
  });
  it('separates same-named immutable packages on Windows and Linux', () => {
    for (const root of ['C:/app/models','/app/models']) {
      const first = modelMetadataKey(root + '/packages/anime-aaaa/anime.onnx',root);
      const second = modelMetadataKey(root + '/packages/anime-bbbb/anime.onnx',root);
      expect(first).toBe('packages/anime-aaaa/anime');
      expect(first).not.toBe(second);
      expect(modelMetadataKey(root + '/packages/anime-aaaa/anime.engine',root)).toBe(first);
    }
  });
  it('also separates external models with identical basenames', () => {
    expect(modelMetadataKey('/one/anime.onnx','/app/models')).not.toBe(modelMetadataKey('/two/anime.onnx','/app/models'));
  });
});
