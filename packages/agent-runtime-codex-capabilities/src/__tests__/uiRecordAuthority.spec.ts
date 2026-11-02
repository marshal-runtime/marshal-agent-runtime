import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileBackedReactUiRecordAuthenticator } from '../ui/recordAuthority.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex React UI record authority', () => {
  it('persists one host key and rejects a different authority signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marshal-ui-record-authority-'));
    roots.push(root);
    const keyPath = join(root, 'keys', 'ui.key');
    const first = createFileBackedReactUiRecordAuthenticator({ keyPath });
    const signature = await first.sign('executable-record');
    const restarted = createFileBackedReactUiRecordAuthenticator({ keyPath });

    expect(await restarted.verify('executable-record', signature)).toBe(true);
    expect(await restarted.verify('different-record', signature)).toBe(false);
    expect((await readFile(keyPath)).byteLength).toBe(32);
  });
});
