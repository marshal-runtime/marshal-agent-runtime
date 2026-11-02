import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ReactUiRecordSeal {
  schemaVersion: 1;
  authorityId: string;
  signature: string;
}

/**
 * Harness-owned authenticity boundary for persisted executable UI records.
 * The runtime supplies canonical bytes; the authority keeps its key material
 * outside agent-authored state and never exposes it through capability output.
 */
export interface ReactUiRecordAuthenticator {
  readonly authorityId: string;
  sign(payload: string): Promise<string>;
  verify(payload: string, signature: string): Promise<boolean>;
}

export interface HmacReactUiRecordAuthenticatorOptions {
  authorityId: string;
  key: Uint8Array | (() => Promise<Uint8Array>);
}

/** Portable HMAC implementation; harness adapters decide how the key is held. */
export class HmacReactUiRecordAuthenticator implements ReactUiRecordAuthenticator {
  readonly authorityId: string;
  private keyPromise?: Promise<Uint8Array>;

  constructor(private readonly options: HmacReactUiRecordAuthenticatorOptions) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.authorityId)) {
      throw new Error('React UI record authority id is invalid');
    }
    this.authorityId = options.authorityId;
  }

  async sign(payload: string): Promise<string> {
    return createHmac('sha256', await this.key()).update(payload).digest('hex');
  }

  async verify(payload: string, signature: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(signature)) return false;
    const expected = Buffer.from(await this.sign(payload), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async key(): Promise<Uint8Array> {
    this.keyPromise ??= Promise.resolve(
      typeof this.options.key === 'function' ? this.options.key() : this.options.key,
    ).then((value) => {
      const key = Uint8Array.from(value);
      if (key.byteLength < 32) throw new Error('React UI record authority key must contain at least 32 bytes');
      return key;
    });
    return this.keyPromise;
  }
}
