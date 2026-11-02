import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InvocationContext, CapabilityInvocationResult } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiApplicationManifest, UiAuthoringProfile } from '../applicationTypes.js';
import { UiAuthoringProfileRegistry } from '../authoringProfiles.js';
import { createReactUiCapabilities } from '../factory.js';

const temporaryRoots: string[] = [];

const ACME_PROFILE: UiAuthoringProfile = {
  id: 'acme-design',
  version: '2.1.0',
  portable: false,
  packageImports: ['acme-ui'],
  packageVersions: { 'acme-ui': '3.4.5' },
  designTokens: { accent: 'var(--acme-accent)' },
  templates: ['compact-card', 'fullscreen-workspace'],
  authoringGuidance: 'Use the adapter-supplied Acme primitives when useful; custom React remains valid.',
  accessibilityRequirements: ['Meet WCAG 2.2 AA.'],
  layoutConstraints: ['Keep inline usable at 320 CSS pixels.'],
  requiredHostCapabilities: ['extensions.acme'],
  optionalHostExtensions: ['acme.openPanel'],
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('UI authoring profile registry integration', () => {
  it('discovers and selects an adapter profile from truthful host capabilities', () => {
    const registry = new UiAuthoringProfileRegistry({
      profiles: [ACME_PROFILE],
      preferred: { id: ACME_PROFILE.id, version: ACME_PROFILE.version },
    });

    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'marshal-standards', portable: true,
        accessibilityRequirements: expect.arrayContaining([expect.stringContaining('WCAG')]),
        layoutConstraints: expect.arrayContaining([expect.stringContaining('inline')]),
      }),
      expect.objectContaining({
        id: 'acme-design',
        packageVersions: { 'acme-ui': '3.4.5' },
      }),
    ]);
    expect(registry.select(undefined, { extensions: { acme: {} } })).toMatchObject({
      status: 'selected',
      origin: 'preferred',
      requested: { id: 'acme-design', version: '2.1.0' },
      profile: { id: 'acme-design', version: '2.1.0' },
      routingGuidance: expect.stringContaining('Before authoring TSX'),
    });
  });

  it('keeps the portable standards profile vendor-neutral', () => {
    const standards = new UiAuthoringProfileRegistry().list()[0]!;
    expect(standards).toMatchObject({ id: 'marshal-standards', portable: true, packageImports: [] });
    expect(JSON.stringify(standards).toLowerCase()).not.toMatch(/openai|codex|chatgpt/);
    expect(standards.accessibilityRequirements).not.toHaveLength(0);
    expect(standards.layoutConstraints).not.toHaveLength(0);
    // Requirements are routed as authoring input. Rendered conformance belongs
    // to target-harness accessibility/responsive release gates.
    expect(standards).not.toHaveProperty('accessibilityValidated');
    expect(standards).not.toHaveProperty('layoutValidated');
  });

  it('falls back to standards for unavailable versions and missing host capabilities', () => {
    const registry = new UiAuthoringProfileRegistry({ profiles: [ACME_PROFILE] });
    expect(registry.select({ id: 'acme-design', version: '1.0.0' }, {
      extensions: { acme: {} },
    })).toMatchObject({
      status: 'fallback',
      origin: 'fallback',
      requested: { id: 'acme-design', version: '1.0.0' },
      profile: { id: 'marshal-standards' },
      reason: 'Requested authoring profile is unavailable.',
    });
    expect(registry.select({ id: 'acme-design' }, {})).toMatchObject({
      status: 'fallback',
      origin: 'fallback',
      profile: { id: 'marshal-standards' },
      reason: 'Host does not advertise: extensions.acme.',
    });
  });

  it('drives package allowlisting and stamps component, receipt, artifact, and manifest provenance', async () => {
    const workspacePath = await workspace({
      'node_modules/acme-ui/package.json': JSON.stringify({
        name: 'acme-ui',
        version: '3.4.5',
        type: 'module',
        exports: './index.js',
      }),
      'node_modules/acme-ui/index.js': 'export const Badge = ({children}) => children;',
      'Profiled.tsx': "import {Badge} from 'acme-ui'; export default function App(){return <Badge>Profiled</Badge>}",
      'Custom.tsx': 'export default function App(){return <section style={{color:"tomato"}}>Custom</section>}',
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
      authoringProfiles: [ACME_PROFILE],
      hostCapabilities: { extensions: { acme: {} } },
    });

    const listed = await bundle.provider.invoke('ui.authoring.profiles.list', {}, context());
    expect(output(listed)).toMatchObject({
      profiles: expect.arrayContaining([expect.objectContaining({ id: 'acme-design' })]),
      selection: { status: 'selected', profile: { id: 'marshal-standards' } },
    });
    const selected = await bundle.provider.invoke(
      'ui.authoring.profiles.select',
      { id: 'acme-design' },
      context(),
    );
    expect(output(selected)).toMatchObject({
      selection: { status: 'selected', profile: { id: 'acme-design' } },
    });

    const compiled = await bundle.provider.invoke('ui.compile', {
      entryPath: 'Profiled.tsx',
      title: 'Profiled',
      authoringProfile: { id: 'acme-design', version: '2.1.0' },
    }, context());
    const component = output(compiled).component as Record<string, unknown>;
    expect(component.authoringProfile).toEqual({
      id: 'acme-design',
      version: '2.1.0',
      status: 'selected',
      origin: 'explicit',
      requested: { id: 'acme-design', version: '2.1.0' },
      packageImports: ['acme-ui'],
    });
    expect(compiled.receipt).toEqual(expect.objectContaining({
      authoringProfile: component.authoringProfile,
    }));
    expect(compiled.artifacts?.[0]?.metadata).toEqual(expect.objectContaining({
      authoringProfile: component.authoringProfile,
    }));

    const rendered = await bundle.provider.invoke('ui.render', {
      componentId: component.id,
      fallback: { summary: 'Profiled fallback' },
      application: application(),
    }, context());
    expect((output(rendered).render as Record<string, unknown>).application).toEqual(
      expect.objectContaining({ authoringProfile: { id: 'acme-design', version: '2.1.0' } }),
    );

    await expect(bundle.provider.invoke('ui.render', {
      componentId: component.id,
      fallback: { summary: 'Mismatch' },
      application: { ...application(), authoringProfile: { id: 'marshal-standards', version: '1.0.0' } },
    }, context())).rejects.toThrow('does not match compiled component profile');

    await expect(bundle.provider.invoke('ui.compile', {
      entryPath: 'Profiled.tsx',
      title: 'Not allowlisted',
    }, context())).rejects.toThrow('Package import acme-ui is not allow-listed');

    const custom = await bundle.provider.invoke('ui.compile', {
      entryPath: 'Custom.tsx',
      title: 'Custom',
    }, context());
    expect((output(custom).component as Record<string, unknown>).authoringProfile).toMatchObject({
      id: 'marshal-standards',
      status: 'selected',
      packageImports: [],
    });
  });

  it('compiles with standards fallback while retaining the unavailable request', async () => {
    const workspacePath = await workspace({
      'App.tsx': 'export default function App(){return <main>Fallback</main>}',
    });
    const bundle = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.state'),
      authoringProfiles: [ACME_PROFILE],
    });
    const compiled = await bundle.provider.invoke('ui.compile', {
      entryPath: 'App.tsx',
      title: 'Fallback',
      authoringProfile: { id: 'acme-design' },
    }, context());
    expect((output(compiled).component as Record<string, unknown>).authoringProfile).toMatchObject({
      id: 'marshal-standards',
      version: '1.0.0',
      status: 'fallback',
      requested: { id: 'acme-design' },
      reason: 'Host does not advertise: extensions.acme.',
    });
  });

  it('normalizes package subpaths and fails closed when a registered profile is unavailable', async () => {
    const subpathProfile: UiAuthoringProfile = {
      ...ACME_PROFILE,
      id: 'acme-subpath',
      packageImports: ['@acme/ui/components/Button'],
      packageVersions: { '@acme/ui/css': '3.4.5' },
    };
    const registry = new UiAuthoringProfileRegistry({ profiles: [subpathProfile] });
    expect(registry.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'acme-subpath',
        packageImports: ['@acme/ui'],
        packageVersions: { '@acme/ui': '3.4.5' },
      }),
    ]));

    const workspacePath = await workspace({
      'Registered.tsx': 'export default function Registered(){return <main>Registered</main>}',
    });
    const reviewer = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.review-state'),
      authoringProfiles: [ACME_PROFILE],
      hostCapabilities: { extensions: { acme: {} } },
    });
    const audit = await reviewer.compiler.snapshotRegisteredGraph({
      entryPath: 'Registered.tsx',
      authoringProfile: { id: ACME_PROFILE.id, version: ACME_PROFILE.version },
    });
    const runtime = createReactUiCapabilities({
      workspacePath,
      stateRoot: join(workspacePath, '.runtime-state'),
      authoringProfiles: [ACME_PROFILE],
      registeredComponents: [{
        id: 'registered-profile', version: '1.0.0', title: 'Registered', entryPath: 'Registered.tsx',
        authoringProfile: { id: ACME_PROFILE.id, version: ACME_PROFILE.version },
        audit: { reviewedBy: 'reviewer', reviewedAt: new Date(0).toISOString(), ...audit },
      }],
    });
    await expect(runtime.provider.invoke(
      'ui.registered.compile', { componentId: 'registered-profile' }, context(),
    )).rejects.toThrow('requires unavailable authoring profile');
  });
});

function application(): UiApplicationManifest {
  return {
    version: '1.0.0',
    presentationModes: ['inline'],
    actions: [],
    tools: [],
  };
}

function context(): InvocationContext {
  return {
    principal: { id: 'profile-test', kind: 'agent' },
    scope: { workspaceId: 'workspace', projectId: 'project', sessionId: 'session' },
  };
}

function output(result: CapabilityInvocationResult): Record<string, unknown> {
  return result.output as Record<string, unknown>;
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-ui-profiles-'));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}
