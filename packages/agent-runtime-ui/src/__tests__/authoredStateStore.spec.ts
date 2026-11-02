import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactUiAuthoredStateStore } from '../authored-state/store.js';
import { digest, stableStringify } from '../store.js';
import type { UiApplicationSourceProvenance } from '../authored-state/contracts.js';

const temporaryRoots: string[] = [];
const context: InvocationContext = {
  principal: { id: 'authored-ui-agent', kind: 'agent' },
  scope: {
    workspaceId: 'workspace-one',
    projectId: 'project-one',
    sessionId: 'session-one',
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe('authored UI state persistence', () => {
  it('round-trips immutable scoped snapshots across restarts', async () => {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'marshal-authored-ui-')));
    temporaryRoots.push(storageRoot);
    const store = new ReactUiAuthoredStateStore({ storageRoot });
    const created = await store.create({
      application: {
        version: '1.0.0',
        presentationModes: ['inline'],
        actions: [],
        tools: [],
      },
      provenance: {
        ...provenance('a'),
        kind: 'workspace_file',
        path: 'src/App.tsx',
      },
      title: 'Authored application',
      tags: ['alpha', 'alpha'],
      metadata: { mode: 'expanded' },
      initialState: { count: 1 },
    }, context);
    const originalSnapshot = structuredClone(created);

    expect(created.owner).toMatchObject({
      principalId: context.principal.id,
      scope: 'project',
    });
    expect(created.owner.scopeId).toHaveLength(32);
    expect(created.tags).toEqual(['alpha']);

    const restarted = new ReactUiAuthoredStateStore({ storageRoot });
    const sameProjectContext: InvocationContext = {
      ...context,
      scope: { ...context.scope, sessionId: 'session-two' },
    };
    await expect(restarted.read(created.identity.id, sameProjectContext))
      .resolves.toEqual(created);
    await expect(restarted.read(created.identity.id, {
      ...context,
      scope: { ...context.scope, projectId: 'project-two' },
    })).resolves.toBeUndefined();

    created.state.count = 99;
    await expect(restarted.read(created.identity.id, context))
      .resolves.toMatchObject({ state: { count: 1 } });

    const metadataUpdate = await restarted.update(created.identity.id, {
      expectedVersion: 1,
      title: null,
      tags: null,
      metadata: null,
    }, context);
    expect(metadataUpdate.identity).toEqual(created.identity);
    expect(metadataUpdate).not.toHaveProperty('title');
    expect(metadataUpdate.tags).toEqual([]);
    expect(metadataUpdate.metadata).toEqual({});

    await expect(restarted.update(created.identity.id, {
      expectedVersion: 2,
      application: created.application,
    }, context)).rejects.toThrow(
      'Revision updates must include application, props, and provenance',
    );

    const revised = await restarted.update(created.identity.id, {
      expectedVersion: 2,
      application: created.application,
      props: { revision: 2 },
      provenance: provenance('b'),
    }, context);
    expect(revised.identity).toEqual(created.identity);
    expect(revised.provenance).toEqual(provenance('b'));

    const stateChanged = await restarted.changeState(
      created.identity.id,
      { count: 2 },
      3,
      context,
    );
    expect(stateChanged.state).toEqual({ count: 2 });
    await expect(restarted.readSnapshot(
      created.identity.id,
      created.snapshotDigest,
      context,
    )).resolves.toEqual(originalSnapshot);

    await expect(restarted.remove(created.identity.id, 4, context))
      .resolves.toBe(true);
    const afterRemovalRestart = new ReactUiAuthoredStateStore({ storageRoot });
    await expect(afterRemovalRestart.read(created.identity.id, context))
      .resolves.toBeUndefined();
    await expect(afterRemovalRestart.readSnapshot(
      created.identity.id,
      created.snapshotDigest,
      context,
    )).resolves.toEqual(originalSnapshot);
  });

  it('revalidates optimistic versions after acquiring the mutation lock', async () => {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'marshal-authored-ui-')));
    temporaryRoots.push(storageRoot);
    const store = new ReactUiAuthoredStateStore({ storageRoot });
    const created = await store.create({
      application: {
        version: '1.0.0',
        presentationModes: ['inline'],
        actions: [],
        tools: [],
      },
      provenance: provenance('a'),
      initialState: { winner: 'none' },
    }, context);

    const results = await Promise.allSettled([
      store.changeState(created.identity.id, { winner: 'first' }, 1, context),
      store.changeState(created.identity.id, { winner: 'second' }, 1, context),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(store.read(created.identity.id, context)).resolves.toMatchObject({
      version: 2,
    });
    await expect(store.changeState('../outside', {}, 1, context))
      .rejects.toThrow('application id is invalid');
  });

  it('rejects a snapshot whose embedded digest does not match its address', async () => {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'marshal-authored-ui-')));
    temporaryRoots.push(storageRoot);
    const store = new ReactUiAuthoredStateStore({ storageRoot });
    const created = await store.create({
      application: {
        version: '1.0.0',
        presentationModes: ['inline'],
        actions: [],
        tools: [],
      },
      provenance: provenance('a'),
    }, context);
    const path = join(
      storageRoot,
      'scopes',
      created.owner.scopeId,
      'snapshots',
      created.identity.id,
      `${created.snapshotDigest}.json`,
    );
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as {
      snapshotDigest: string;
    };
    snapshot.snapshotDigest = '0'.repeat(64);
    await writeFile(path, JSON.stringify(snapshot), 'utf8');

    await expect(store.read(created.identity.id, context))
      .rejects.toThrow('Authored UI snapshot digest mismatch');
  });

  it('migrates legacy schema-v2 identity revision fields after restart', async () => {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'marshal-authored-ui-')));
    temporaryRoots.push(storageRoot);
    const store = new ReactUiAuthoredStateStore({ storageRoot });
    const created = await store.create({
      identity: { id: 'legacy-app' },
      application: {
        version: '1.0.0',
        presentationModes: ['inline'],
        actions: [],
        tools: [],
      },
      props: { legacy: true },
      provenance: provenance('a'),
    }, context);
    const snapshotDirectory = join(
      storageRoot,
      'scopes',
      created.owner.scopeId,
      'snapshots',
      created.identity.id,
    );
    const currentPath = join(
      snapshotDirectory,
      `${created.snapshotDigest}.json`,
    );
    const raw = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>;
    const source = raw.provenance as UiApplicationSourceProvenance;
    raw.identity = {
      id: created.identity.id,
      componentId: source.componentId,
      renderId: source.renderId,
      componentDigest: source.componentDigest,
      renderDigest: source.renderDigest,
    };
    const legacyDigest = persistedSnapshotDigest(raw);
    raw.snapshotDigest = legacyDigest;
    const legacyPath = join(snapshotDirectory, `${legacyDigest}.json`);
    await writeFile(legacyPath, JSON.stringify(raw), 'utf8');
    await writeFile(
      join(
        storageRoot,
        'scopes',
        created.owner.scopeId,
        'heads',
        `${created.identity.id}.json`,
      ),
      JSON.stringify({
        schemaVersion: 2,
        id: created.identity.id,
        scopeKey: created.owner.scopeId,
        owner: created.owner,
        tombstoned: false,
        version: created.version,
        snapshotDigest: legacyDigest,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      }),
      'utf8',
    );

    const restarted = new ReactUiAuthoredStateStore({ storageRoot });
    await expect(restarted.read(created.identity.id, context)).resolves.toMatchObject({
      identity: { id: created.identity.id },
      application: created.application,
      props: created.props,
      provenance: created.provenance,
      snapshotDigest: legacyDigest,
    });
    expect((await restarted.read(created.identity.id, context))?.identity)
      .toEqual({ id: created.identity.id });

    await writeFile(
      legacyPath,
      JSON.stringify({ ...raw, title: 'tampered after hashing' }),
      'utf8',
    );
    await expect(restarted.read(created.identity.id, context))
      .rejects.toThrow('Authored UI snapshot digest mismatch');
    await writeFile(legacyPath, JSON.stringify(raw), 'utf8');

    const updated = await restarted.update(created.identity.id, {
      expectedVersion: created.version,
      title: 'Migrated application',
    }, context);
    expect(updated.identity).toEqual({ id: created.identity.id });
    expect(updated.snapshotDigest).not.toBe(legacyDigest);
  });
});

function provenance(seed: string): UiApplicationSourceProvenance {
  return {
    kind: 'snapshot',
    sourceDigest: seed.repeat(64),
    componentId: 'c'.repeat(64),
    renderId: 'd'.repeat(64),
    componentDigest: 'e'.repeat(64),
    renderDigest: 'f'.repeat(64),
  };
}

function persistedSnapshotDigest(value: Record<string, unknown>): string {
  const { snapshotDigest: _ignored, ...content } = value;
  return digest(stableStringify(content));
}
