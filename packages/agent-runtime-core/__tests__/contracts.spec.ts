import { describe, expect, it } from 'vitest';
import {
  assertSupportedProtocolVersion,
  isSupportedProtocolVersion,
  UnsupportedProtocolVersionError,
} from '../src/index.js';

describe('protocol compatibility', () => {
  it('accepts compatible major versions', () => {
    expect(isSupportedProtocolVersion('1.0.0')).toBe(true);
    expect(isSupportedProtocolVersion('1.9.2')).toBe(true);
    expect(() => assertSupportedProtocolVersion('1.1.0')).not.toThrow();
  });

  it('rejects incompatible and malformed versions', () => {
    for (const version of ['2.0.0', '0.9.0', '1', 'latest', '']) {
      expect(isSupportedProtocolVersion(version)).toBe(false);
      expect(() => assertSupportedProtocolVersion(version)).toThrow(
        UnsupportedProtocolVersionError,
      );
    }
  });
});
