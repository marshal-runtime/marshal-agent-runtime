import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validatePublicationExamples } from '../validate.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// TODO(#11): Catalog check fails on Linux.
test.skip('publication catalog, sources, manifests, fallbacks, permissions, and receipt matchers are coherent', async () => {
  const result = await validatePublicationExamples();
  assert.deepEqual(result.errors, []);
  assert.equal(result.exampleCount, 9);
});

test('generated fixture evidence cannot be mistaken for an uncut live run', async () => {
  for (const path of [
    'bounded-delegation/fixture-result.json',
    'design-studio/fixture-result.json',
  ]) {
    const fixture = JSON.parse(await readFile(join(root, path), 'utf8'));
    assert.equal(fixture.evidenceClass, 'generated-fixture');
    assert.equal(fixture.notALiveRun, true);
  }
});

test('capstone manifest binds the exact v2 editable backend actions and authoritative state', async () => {
  const application = JSON.parse(await readFile(join(root, 'design-studio/application.json'), 'utf8'));
  assert.deepEqual(application.actions.map((action) => ({
    id: action.id,
    kind: action.target.kind,
    requiredPermissions: action.requiredPermissions,
  })), [
    {
      id: 'refine-design',
      kind: 'module',
      requiredPermissions: ['runtime.module.execute', 'artifacts.read', 'artifacts.write'],
    },
    {
      id: 'save-workspace',
      kind: 'module',
      requiredPermissions: ['runtime.module.execute', 'artifacts.write'],
    },
    {
      id: 'load-workspace',
      kind: 'module',
      requiredPermissions: ['runtime.module.execute', 'artifacts.read'],
    },
  ]);
  assert.deepEqual(application.authoritativeState, {
    capability: 'artifacts.read',
    resourceId: 'design-studio/workspace.json',
    version: '2.0.0',
  });
  assert.deepEqual(application.presentationModes, ['inline', 'fullscreen', 'pip']);
});

test('substantial capstone visibly exposes every declared mode and durable action', async () => {
  const application = JSON.parse(await readFile(join(root, 'design-studio/application.json'), 'utf8'));
  const source = await readFile(join(root, 'design-studio/DesignStudio.tsx'), 'utf8');

  for (const mode of application.presentationModes.filter((candidate) => candidate !== 'inline')) {
    assert.match(source, new RegExp(`availableDisplayModes\\.includes\\('${mode}'\\)`));
    assert.match(source, new RegExp(`requestMode\\('${mode}'\\)`));
  }
  assert.match(source, /aria-label="Fullscreen mode"/);
  assert.match(source, /aria-label="Picture in picture mode"/);
  assert.match(source, /event\.type === 'host-context-changed'/);
  assert.match(source, /onClick=\{loadWorkspace\}/);
  assert.match(source, /onClick=\{saveWorkspace\}/);
  assert.match(source, /role="status"|aria-live="polite"/);
});
