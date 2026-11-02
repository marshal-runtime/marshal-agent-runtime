import { describe, expect, it } from 'vitest';
import { sameStableFileIdentity } from '../src/fileIdentity.js';

const pathStat = Object.freeze({
  dev: 0,
  ino: 1_688_849_862_388_071,
  birthtimeMs: 1_700_000_000_000,
  size: 999,
  mode: 33_206,
  ctimeMs: 1_700_000_000_100,
  mtimeMs: 1_700_000_000_200,
});

const descriptorStat = Object.freeze({ ...pathStat, dev: 3_700_311_042 });

describe('sameStableFileIdentity', () => {
  it('accepts the one-sided Windows Node 22 zero-device asymmetry', () => {
    expect(sameStableFileIdentity(pathStat, descriptorStat, 'win32')).toBe(true);
    expect(sameStableFileIdentity(descriptorStat, pathStat, 'win32')).toBe(true);
  });

  it.each([
    ['ino', descriptorStat.ino + 1],
    ['birthtimeMs', descriptorStat.birthtimeMs + 1],
    ['size', descriptorStat.size + 1],
    ['mode', descriptorStat.mode ^ 1],
  ] as const)('rejects a changed fallback identity field: %s', (field, value) => {
    expect(sameStableFileIdentity(pathStat, { ...descriptorStat, [field]: value }, 'win32')).toBe(false);
  });

  it('leaves mutable timestamp snapshot checks to the caller', () => {
    expect(sameStableFileIdentity(pathStat, {
      ...descriptorStat,
      ctimeMs: descriptorStat.ctimeMs + 1,
      mtimeMs: descriptorStat.mtimeMs + 1,
    }, 'win32')).toBe(true);
  });

  it('rejects the asymmetry outside Windows', () => {
    expect(sameStableFileIdentity(pathStat, descriptorStat, 'linux')).toBe(false);
  });

  it('rejects mismatched non-zero devices', () => {
    expect(sameStableFileIdentity(
      { ...descriptorStat, dev: 41 },
      { ...descriptorStat, dev: 42 },
      'win32',
    )).toBe(false);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed for an unavailable or invalid inode: %s',
    (ino) => {
      expect(sameStableFileIdentity({ ...descriptorStat, ino }, { ...descriptorStat, ino }, 'win32')).toBe(false);
      expect(sameStableFileIdentity({ ...pathStat, ino }, { ...descriptorStat, ino }, 'win32')).toBe(false);
    },
  );

  it('preserves exact device-and-inode identity when devices match', () => {
    expect(sameStableFileIdentity(descriptorStat, { ...descriptorStat, size: 1 }, 'win32')).toBe(true);
    expect(sameStableFileIdentity(
      descriptorStat,
      { ...descriptorStat, ino: descriptorStat.ino + 1 },
      'win32',
    )).toBe(false);
  });
});
