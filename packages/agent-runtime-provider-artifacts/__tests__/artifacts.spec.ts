import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { hashedScopeSegment } from '@marshal/agent-runtime-provider-kit';
import { createArtifactProvider } from '../src/artifacts.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function context(sessionId: string, principalId = 'agent-1', principalKind = 'agent'): InvocationContext {
  return {
    principal: { id: principalId, kind: principalKind },
    scope: { workspaceId: 'workspace-1', projectId: 'project-1', sessionId },
  };
}

describe('artifact provider', () => {
  it('writes first-time sibling artifacts concurrently in one new scope', async () => {
    const root = await createTempDirectory();
    const provider = createArtifactProvider({ rootDirectory: root });
    const invocationContext = context('concurrent-session');

    await Promise.all([
      provider.invoke(
        'artifacts.write',
        { path: 'workspace/state.json', content: '{"selected":"branchscape"}' },
        invocationContext,
      ),
      provider.invoke(
        'artifacts.write',
        { path: 'workspace/source.tsx', content: 'export default function App() {}' },
        invocationContext,
      ),
    ]);

    const [state, source] = await Promise.all([
      provider.invoke('artifacts.read', { path: 'workspace/state.json' }, invocationContext),
      provider.invoke('artifacts.read', { path: 'workspace/source.tsx' }, invocationContext),
    ]);
    expect(state.output).toMatchObject({ content: '{"selected":"branchscape"}' });
    expect(source.output).toMatchObject({ content: 'export default function App() {}' });
  });

  it('isolates identical logical paths by session and emits provider receipts', async () => {
    const root = await createTempDirectory();
    const provider = createArtifactProvider({ rootDirectory: root });
    const first = await provider.invoke('artifacts.write', { path: 'report.txt', content: 'alpha' }, context('session-a'));
    await provider.invoke('artifacts.write', { path: 'report.txt', content: 'beta' }, context('session-b'));
    const readA = await provider.invoke('artifacts.read', { path: 'report.txt' }, context('session-a'));
    const readB = await provider.invoke('artifacts.read', { path: 'report.txt' }, context('session-b'));
    const listed = await provider.invoke('artifacts.list', {}, context('session-a'));

    expect((readA.output as { content: string }).content).toBe('alpha');
    expect((readB.output as { content: string }).content).toBe('beta');
    expect((listed.output as { artifacts: Array<{ path: string }> }).artifacts).toEqual([
      expect.objectContaining({ path: 'report.txt' }),
    ]);
    expect(first.receipt).toMatchObject({ providerId: 'marshal.artifacts', capability: 'artifacts.write' });
    expect((first.receipt as { inputDigest: string }).inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('isolates identical scope and logical paths by stable principal owner', async () => {
    const root = await createTempDirectory();
    const provider = createArtifactProvider({ rootDirectory: root });
    await provider.invoke('artifacts.write', { path: 'private.txt', content: 'alpha' }, context('same', 'principal-a'));

    await expect(provider.invoke(
      'artifacts.read',
      { path: 'private.txt' },
      context('same', 'principal-b'),
    )).rejects.toMatchObject({ code: 'ENOENT' });
    await provider.invoke('artifacts.write', { path: 'private.txt', content: 'beta' }, context('same', 'principal-b'));

    const first = await provider.invoke('artifacts.read', { path: 'private.txt' }, context('same', 'principal-a'));
    const second = await provider.invoke('artifacts.read', { path: 'private.txt' }, context('same', 'principal-b'));
    expect(first.output).toMatchObject({ content: 'alpha', scope: { principalId: 'principal-a' } });
    expect(second.output).toMatchObject({ content: 'beta', scope: { principalId: 'principal-b' } });
  });

  it('keeps the legacy unowned namespace disabled unless one nominated owner opts in', async () => {
    const root = await createTempDirectory();
    const legacyFile = await writeLegacyArtifact(root, 'legacy.txt', 'legacy');
    const disabled = createArtifactProvider({ rootDirectory: root });
    await expect(disabled.invoke('artifacts.read', { path: 'legacy.txt' }, context('same')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const readOnly = createArtifactProvider({
      rootDirectory: root,
      legacyAccess: { mode: 'read-only', ownerPrincipalId: 'principal-a' },
    });
    const read = await readOnly.invoke(
      'artifacts.read',
      { path: 'legacy.txt' },
      context('same', 'principal-a'),
    );
    expect(read.output).toMatchObject({ content: 'legacy', scope: { principalId: 'principal-a' } });
    await expect(readOnly.invoke(
      'artifacts.read',
      { path: 'legacy.txt' },
      context('same', 'principal-b'),
    )).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readOnly.invoke(
      'artifacts.read',
      { path: 'legacy.txt' },
      context('same', 'principal-a', 'user'),
    )).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(legacyFile, 'utf8')).resolves.toBe('legacy');
  });

  it('rejects an ancestor symlink in the opted-in legacy listing namespace', async (testContext) => {
    const root = await createTempDirectory();
    const outside = await createTempDirectory();
    const escapedScope = path.join(
      outside,
      hashedScopeSegment('workspace', 'workspace-1'),
      'projects',
      hashedScopeSegment('project', 'project-1'),
      'sessions',
      hashedScopeSegment('session', 'same'),
    );
    await fs.mkdir(escapedScope, { recursive: true });
    await fs.writeFile(path.join(escapedScope, 'outside.txt'), 'outside');
    try {
      await fs.symlink(outside, path.join(root, 'workspaces'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip();
        return;
      }
      throw error;
    }
    const provider = createArtifactProvider({
      rootDirectory: root,
      legacyAccess: {
        mode: 'read-only',
        ownerPrincipalId: 'principal-a',
        ownerPrincipalKind: 'agent',
      },
    });
    await expect(provider.invoke(
      'artifacts.list',
      { scope: 'session' },
      context('same', 'principal-a'),
    )).rejects.toThrow(/symbolic link|escaped/i);
  });

  it('migrates nominated legacy files into the principal namespace on read', async () => {
    const root = await createTempDirectory();
    const legacyFile = await writeLegacyArtifact(root, 'nested/legacy.txt', 'migrated');
    const provider = createArtifactProvider({
      rootDirectory: root,
      legacyAccess: { mode: 'migrate-on-read', ownerPrincipalId: 'principal-a' },
    });

    const read = await provider.invoke(
      'artifacts.read',
      { path: 'nested/legacy.txt' },
      context('same', 'principal-a'),
    );
    expect(read.output).toMatchObject({ content: 'migrated' });
    await expect(fs.stat(legacyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const migrated = await findFile(path.join(root, 'principals'), 'legacy.txt');
    await expect(fs.readFile(migrated, 'utf8')).resolves.toBe('migrated');
  });

  it('rejects traversal, oversize writes, and implicit overwrites', async () => {
    const root = await createTempDirectory();
    const provider = createArtifactProvider({ rootDirectory: root, maxArtifactBytes: 4 });
    await expect(provider.invoke('artifacts.write', { path: '../escape', content: 'x' }, context('s'))).rejects.toThrow(/invalid path|relative logical/i);
    await expect(provider.invoke('artifacts.write', { path: 'large', content: '12345' }, context('s'))).rejects.toThrow(/byte write limit/i);
    await provider.invoke('artifacts.write', { path: 'same', content: 'one' }, context('s'));
    await expect(provider.invoke('artifacts.write', { path: 'same', content: 'two' }, context('s'))).rejects.toThrow(/already exists/i);
    await provider.invoke('artifacts.write', { path: 'same', content: 'two', overwrite: true }, context('s'));
    const read = await provider.invoke('artifacts.read', { path: 'same' }, context('s'));
    expect((read.output as { content: string }).content).toBe('two');
  });

  it('does not follow a symlink planted inside a scope', async (testContext) => {
    const root = await createTempDirectory();
    const outside = await createTempDirectory();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    const provider = createArtifactProvider({ rootDirectory: root });
    await provider.invoke('artifacts.write', { path: 'seed.txt', content: 'seed' }, context('s'));
    const seedPath = await findFile(root, 'seed.txt');
    const linkPath = path.join(path.dirname(seedPath), 'escape');
    try {
      await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip();
        return;
      }
      throw error;
    }
    await expect(provider.invoke('artifacts.read', { path: 'escape/secret.txt' }, context('s'))).rejects.toThrow(/symbolic link/i);
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-artifacts-test-'));
  tempDirectories.push(directory);
  return directory;
}

async function findFile(directory: string, name: string): Promise<string> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, name).catch(() => undefined);
      if (nested) return nested;
    }
  }
  throw new Error(`Could not find ${name}`);
}

async function writeLegacyArtifact(root: string, logicalPath: string, content: string): Promise<string> {
  const directory = path.join(
    root,
    'workspaces',
    hashedScopeSegment('workspace', 'workspace-1'),
    'projects',
    hashedScopeSegment('project', 'project-1'),
    'sessions',
    hashedScopeSegment('session', 'same'),
  );
  const file = path.join(directory, logicalPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
