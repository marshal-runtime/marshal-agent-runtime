import { describe, expect, it } from 'vitest';
import { validateUiApplicationManifest } from '../applicationManifest.js';

describe('optional host facilities', () => {
  const manifest = { version: '1.0.0', presentationModes: ['inline'], actions: [], tools: [] };
  it('preserves explicit declarations through validation without changing legacy manifests', () => {
    expect(validateUiApplicationManifest(manifest).hostFeatures).toBeUndefined();
    expect(validateUiApplicationManifest({ ...manifest, hostFeatures: ['workspace', 'media'] }).hostFeatures)
      .toEqual(['workspace', 'media']);
  });
  it('rejects unknown, duplicate, and unbounded feature declarations', () => {
    for (const hostFeatures of [['shell'], ['media', 'media'], 'media', ['workspace', 'media', 'shell']]) {
      expect(() => validateUiApplicationManifest({ ...manifest, hostFeatures })).toThrow();
    }
  });
});
