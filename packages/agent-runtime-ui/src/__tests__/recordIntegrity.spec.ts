import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createReactUiCapabilities } from '../factory.js';
import { HmacReactUiRecordAuthenticator } from '../recordAuthority.js';
import { scopeKey } from '../store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persisted React UI integrity', () => {
  it('authenticates executable records and rejects unsigned, forged, or wrong-key state', async () => {
    const { bundle: unsigned, stateRoot, workspacePath, currentContext } = await fixture();
    const compiled = await unsigned.provider.invoke(
      'ui.compile',
      { entryPath: 'App.tsx', title: 'Unsigned legacy app' },
      currentContext,
    );
    const unsignedId = (compiled.output as { component: { id: string } }).component.id;
    const key = new Uint8Array(32).fill(7);
    const authenticated = createReactUiCapabilities({
      workspacePath,
      stateRoot,
      storeLimits: {
        recordAuthenticator: new HmacReactUiRecordAuthenticator({ authorityId: 'test-host', key }),
      },
    });
    await expect(authenticated.store.getComponent(unsignedId, currentContext))
      .rejects.toThrow('Unsigned React UI executable record is not trusted');

    const isolatedStateRoot = join(workspacePath, '.authenticated-state');
    const first = createReactUiCapabilities({
      workspacePath,
      stateRoot: isolatedStateRoot,
      storeLimits: {
        recordAuthenticator: new HmacReactUiRecordAuthenticator({ authorityId: 'test-host', key }),
      },
    });
    const signed = await first.provider.invoke(
      'ui.compile',
      { entryPath: 'App.tsx', title: 'Signed app' },
      currentContext,
    );
    const signedId = (signed.output as { component: { id: string } }).component.id;
    await expect(first.store.getComponent(signedId, currentContext)).resolves.toMatchObject({ id: signedId });

    const wrongKey = createReactUiCapabilities({
      workspacePath,
      stateRoot: isolatedStateRoot,
      storeLimits: {
        recordAuthenticator: new HmacReactUiRecordAuthenticator({
          authorityId: 'test-host',
          key: new Uint8Array(32).fill(8),
        }),
      },
    });
    await expect(wrongKey.store.getComponent(signedId, currentContext))
      .rejects.toThrow('authenticity validation failed');

    const path = join(
      isolatedStateRoot,
      'react-ui',
      'scopes',
      scopeKey(currentContext),
      'components',
      `${signedId}.json`,
    );
    const envelope = JSON.parse(await readFile(path, 'utf8')) as {
      record: Record<string, unknown>;
    };
    envelope.record.title = 'Forged title';
    await writeFile(path, JSON.stringify(envelope), 'utf8');
    await expect(first.store.getComponent(signedId, currentContext))
      .rejects.toThrow('authenticity validation failed');
  });

  it('rejects tampered component HTML even when the filename, id, and scope are unchanged', async () => {
    const { bundle, stateRoot, currentContext } = await fixture();
    const compiled = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'App.tsx', title: 'Integrity app' },
      currentContext,
    );
    const component = (compiled.output as { component: { id: string } }).component;
    const path = join(stateRoot, 'react-ui', 'scopes', scopeKey(currentContext), 'components', `${component.id}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    stored.html = String(stored.html).replace('Integrity', 'Tampered');
    await writeFile(path, JSON.stringify(stored), 'utf8');

    await expect(bundle.store.getComponent(component.id, currentContext))
      .rejects.toThrow('component integrity validation failed');
  });

  it('rejects tampered render bindings before they can hydrate or invoke actions', async () => {
    const { bundle, stateRoot, currentContext } = await fixture();
    const compiled = await bundle.provider.invoke(
      'ui.compile',
      { entryPath: 'App.tsx', title: 'Integrity app' },
      currentContext,
    );
    const component = (compiled.output as { component: { id: string } }).component;
    const rendered = await bundle.provider.invoke(
      'ui.render',
      { componentId: component.id, props: { count: 1 }, fallback: { summary: 'Count 1' } },
      currentContext,
    );
    const render = (rendered.output as { render: { id: string } }).render;
    const path = join(stateRoot, 'react-ui', 'scopes', scopeKey(currentContext), 'renders', `${render.id}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    stored.props = { count: 999 };
    await writeFile(path, JSON.stringify(stored), 'utf8');

    await expect(bundle.store.getRender(render.id, currentContext))
      .rejects.toThrow('workspace binding integrity validation failed');
  });
});

async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'marshal-ui-integrity-'));
  temporaryRoots.push(workspacePath);
  await writeFile(
    join(workspacePath, 'App.tsx'),
    'export default function App(){return <main>Integrity</main>}',
    'utf8',
  );
  const stateRoot = join(workspacePath, '.state');
  await mkdir(stateRoot, { recursive: true });
  return {
    bundle: createReactUiCapabilities({ workspacePath, stateRoot }),
    stateRoot,
    workspacePath,
    currentContext: context(),
  };
}

function context(): InvocationContext {
  return {
    principal: { id: 'record-integrity-test', kind: 'agent' },
    scope: { workspaceId: 'workspace', projectId: 'project', sessionId: 'session' },
  };
}
