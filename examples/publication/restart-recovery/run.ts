import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { createReactUiCapabilities } from '@marshal/agent-runtime-ui';

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const workspacePath = resolve(exampleRoot, '../../..');
const stateRoot = await mkdtemp(join(tmpdir(), 'marshal-ui-recovery-'));
const application = JSON.parse(await readFile(join(exampleRoot, 'application.json'), 'utf8'));
const fallback = JSON.parse(await readFile(join(exampleRoot, 'fallback.json'), 'utf8'));
const context: InvocationContext = {
  principal: { id: 'publication-reader', kind: 'agent' },
  scope: { workspaceId: 'publication', projectId: 'restart-recovery', sessionId: 'before-restart' },
};

try {
  const first = createReactUiCapabilities({ workspacePath, stateRoot });
  const compiled = await first.provider.invoke('ui.compile', {
    entryPath: 'examples/publication/restart-recovery/PersistentPanel.tsx',
    title: 'Persistent project panel',
  }, context);
  const component = (compiled.output as { component: { id: string; sourceDigest: string } }).component;
  const rendered = await first.provider.invoke('ui.render', {
    componentId: component.id,
    props: {},
    fallback,
    application,
  }, context);
  const renderId = (rendered.output as { render: { id: string } }).render.id;
  await first.store.mutateRenderState(renderId, {
    operation: 'set', key: 'view', value: 'evidence', expectedVersion: 0,
  }, context);

  const restarted = createReactUiCapabilities({ workspacePath, stateRoot });
  const recovered = await restarted.store.getApplicationState(renderId, {
    ...context,
    scope: { ...context.scope, sessionId: 'after-restart' },
  });
  console.log(JSON.stringify({ renderId, sourceDigest: component.sourceDigest, state: recovered }, null, 2));
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}
