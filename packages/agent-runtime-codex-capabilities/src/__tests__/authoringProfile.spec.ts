import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_OPENAI_UI_AUTHORING_PROFILE,
  CODEX_OPENAI_UI_PROFILE_ID,
  OPENAI_APPS_SDK_UI_VERSION,
} from '../ui/authoringProfile.js';
import { createCodexCapabilityProviders } from '../createCodexCapabilityProviders.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex/OpenAI UI authoring profile', () => {
  it('is the adapter-selected profile and bundles an adapter-owned Apps SDK UI component', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'marshal-codex-ui-profile-'));
    temporaryRoots.push(workspacePath);
    await writeFile(
      join(workspacePath, 'OpenAiApp.tsx'),
      `import {Button} from '@openai/apps-sdk-ui/components/Button';
       export default function OpenAiApp(){return <Button color="primary">OpenAI UI</Button>}`,
      'utf8',
    );
    let resolveCount = 0;
    let loadCount = 0;
    const bundle = createCodexCapabilityProviders({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
      delegation: { enabled: false },
      reactUi: {
        buildObserver(event) {
          if (event.phase === 'resolve') resolveCount += 1;
          else loadCount += 1;
        },
      },
    });
    try {
      const currentContext = {
        principal: { id: 'codex-profile-test', kind: 'agent' },
        scope: { workspaceId: 'workspace', projectId: 'project', sessionId: 'session' },
      };
      const listed = await bundle.reactUi!.provider.invoke(
        'ui.authoring.profiles.list',
        {},
        currentContext,
      );
      expect(listed.output).toMatchObject({
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: 'marshal-standards', portable: true }),
          expect.objectContaining({
            id: CODEX_OPENAI_UI_PROFILE_ID,
            portable: false,
            packageVersions: { '@openai/apps-sdk-ui': OPENAI_APPS_SDK_UI_VERSION },
          }),
        ]),
        selection: {
          status: 'selected',
          profile: { id: CODEX_OPENAI_UI_PROFILE_ID },
        },
      });
      expect(CODEX_OPENAI_UI_AUTHORING_PROFILE.authoringGuidance).toContain(
        'visible named control',
      );
      expect(CODEX_OPENAI_UI_AUTHORING_PROFILE.authoringGuidance).toContain(
        'Save and Reopen/Load controls',
      );

      const coldStarted = performance.now();
      const compiled = await bundle.reactUi!.provider.invoke('ui.compile', {
        entryPath: 'OpenAiApp.tsx',
        title: 'OpenAI authoring profile',
      }, currentContext);
      const coldMs = performance.now() - coldStarted;
      expect(compiled.output).toMatchObject({
        component: {
          id: expect.stringMatching(/^[a-f0-9]{64}$/),
          authoringProfile: {
            id: CODEX_OPENAI_UI_PROFILE_ID,
            version: CODEX_OPENAI_UI_AUTHORING_PROFILE.version,
            status: 'selected',
            packageImports: ['@openai/apps-sdk-ui'],
          },
        },
      });
      const coldCounts = { resolveCount, loadCount };
      resolveCount = 0;
      loadCount = 0;
      const warmStarted = performance.now();
      const warm = await bundle.reactUi!.provider.invoke('ui.compile', {
        entryPath: 'OpenAiApp.tsx',
        title: 'OpenAI authoring profile',
      }, currentContext);
      const warmMs = performance.now() - warmStarted;
      expect(warm.output).toMatchObject({
        component: { id: (compiled.output as { component: { id: string } }).component.id },
      });
      expect(coldCounts.resolveCount).toBeGreaterThan(1_000);
      expect(coldCounts.loadCount).toBeGreaterThan(500);
      expect(resolveCount).toBe(coldCounts.resolveCount);
      expect(loadCount).toBe(coldCounts.loadCount);
      expect(coldMs).toBeLessThan(15_000);
      expect(warmMs).toBeLessThan(15_000);
      console.info('marshal-ui-profile-benchmark', {
        coldMs: Math.round(coldMs), warmMs: Math.round(warmMs),
        coldResolveCount: coldCounts.resolveCount, coldLoadCount: coldCounts.loadCount,
        warmResolveCount: resolveCount, warmLoadCount: loadCount,
      });
    } finally {
      await bundle.dispose();
    }
  }, 30_000);

  it('can be detached for a standards-only or alternate-harness projection', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'marshal-codex-ui-standards-'));
    temporaryRoots.push(workspacePath);
    const bundle = createCodexCapabilityProviders({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
      delegation: { enabled: false },
      reactUi: { includeCodexAuthoringProfile: false },
    });
    try {
      expect(bundle.reactUi!.compiler.listAuthoringProfiles()).toEqual([
        expect.objectContaining({ id: 'marshal-standards', portable: true }),
      ]);
      expect(bundle.reactUi!.compiler.selectAuthoringProfile()).toMatchObject({
        status: 'selected',
        profile: { id: 'marshal-standards' },
      });
    } finally {
      await bundle.dispose();
    }
  });
});
