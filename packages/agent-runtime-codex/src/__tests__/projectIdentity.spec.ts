import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGitTrustedProjectId } from '../projectIdentity.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Codex Git project identity', () => {
  it('gives a local source without origin and its ordinary clone one stable opaque identity', async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, 'source');
    const clone = path.join(root, 'clone');
    await git(root, ['init', source]);
    await git(root, ['clone', source, clone]);

    const sourceIdentity = await resolveGitTrustedProjectId(source);
    const cloneIdentity = await resolveGitTrustedProjectId(clone);

    expect(sourceIdentity).toMatch(/^codex-git-local-source-[a-f0-9]{64}$/);
    expect(cloneIdentity).toBe(sourceIdentity);
    expect(await resolveGitTrustedProjectId(source)).toBe(sourceIdentity);
    expect(sourceIdentity).not.toContain(source.toLowerCase());
  });

  it('continues to prefer normalized explicit network remotes', async () => {
    const root = await temporaryDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await git(root, ['init', first]);
    await git(root, ['init', second]);
    await git(first, ['remote', 'add', 'origin', 'https://user:secret@EXAMPLE.com/Owner/Repo.git?token=hidden']);
    await git(second, ['remote', 'add', 'origin', 'https://example.com/Owner/Repo']);

    const firstIdentity = await resolveGitTrustedProjectId(first);
    const secondIdentity = await resolveGitTrustedProjectId(second);

    expect(firstIdentity).toMatch(/^codex-git-remote-[a-f0-9]{64}$/);
    expect(secondIdentity).toBe(firstIdentity);
    expect(firstIdentity).not.toContain('secret');
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-project-identity-'));
  roots.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, shell: false });
}
