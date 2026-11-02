import { describe, expect, it } from 'vitest';
import {
  RUNTIME_EXTENSION_UI_PLACEMENT_ANCESTOR_DESCENDANT_COLLISION,
  RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION,
  RuntimeExtensionUiPlacementRegistry,
  type RuntimeExtensionUiHostPlacement,
  type RuntimeExtensionUiPlacementRegistration,
  type RuntimeExtensionUiApplication,
} from '../src/index.js';

const hostPlacements: readonly RuntimeExtensionUiHostPlacement[] = [
  {
    placementId: 'marshal.workspace',
    metadata: {
      title: 'Workspace',
      supportedActions: ['fallback', 'augment', 'replace'],
      supportsFullReplacement: true,
    },
  },
  {
    placementId: 'marshal.workspace.sidebar',
    parentPlacementId: 'marshal.workspace',
    metadata: {
      title: 'Sidebar',
      hasHostContent: false,
      supportedActions: ['replace', 'augment', 'fallback'],
      supportsFullReplacement: true,
      attributes: { region: 'navigation' },
    },
  },
  {
    placementId: 'marshal.workspace.sidebar.footer',
    parentPlacementId: 'marshal.workspace.sidebar',
    metadata: {
      title: 'Sidebar footer',
      supportedActions: ['replace', 'augment', 'fallback'],
    },
  },
];

describe('RuntimeExtensionUiPlacementRegistry', () => {
  it('resolves registrations deterministically without using installation order', () => {
    const registry = new RuntimeExtensionUiPlacementRegistry(hostPlacements);
    const registrations: readonly RuntimeExtensionUiPlacementRegistration[] = [
      registration('@example/zeta', 'zeta', 'marshal.workspace', 'augment'),
      registration('@example/alpha', 'alpha', 'marshal.workspace', 'augment'),
    ];

    const forward = registry.resolve(registrations);
    const reverse = registry.resolve([...registrations].reverse());

    expect(reverse).toEqual(forward);
    expect(resolved(forward, 'marshal.workspace')).toMatchObject({
      placementId: 'marshal.workspace',
      mode: 'augment',
      hostVisible: true,
    });
    expect(resolved(forward, 'marshal.workspace').registrations
      .map(({ extensionId }) => extensionId))
      .toEqual(['@example/alpha', '@example/zeta']);
    expect(resolved(forward, 'marshal.workspace.sidebar').metadata.attributes)
      .toEqual({ region: 'navigation' });
  });

  it('keeps explicit parents before children without inferring hierarchy from IDs', () => {
    const registry = new RuntimeExtensionUiPlacementRegistry([
      {
        placementId: 'a.child',
        parentPlacementId: 'z.parent',
        metadata: {
          title: 'Child',
          supportedActions: ['augment'],
        },
      },
      {
        placementId: 'z.parent',
        metadata: {
          title: 'Parent',
          supportedActions: ['augment'],
        },
      },
    ]);

    expect(registry.listHostPlacements().map(({ placementId }) => placementId)).toEqual([
      'z.parent',
      'a.child',
    ]);
    expect(registry.resolve([]).placements.map(({ placementId }) => placementId)).toEqual([
      'z.parent',
      'a.child',
    ]);
  });

  it('composes augmentations with replacement and fallback bases', () => {
    const replacement = new RuntimeExtensionUiPlacementRegistry(hostPlacements).resolve([
      registration('@example/base', 'base', 'marshal.workspace', 'replace'),
      registration('@example/addon', 'addon', 'marshal.workspace', 'augment'),
      registration('@example/dormant', 'dormant', 'marshal.workspace', 'fallback'),
    ]);

    expect(resolved(replacement, 'marshal.workspace')).toMatchObject({
      mode: 'replace',
      hostVisible: false,
    });
    expect(resolved(replacement, 'marshal.workspace').registrations.map(({ action }) => action))
      .toEqual(['replace', 'augment']);

    const fallback = new RuntimeExtensionUiPlacementRegistry(hostPlacements).resolve([
      registration('@example/addon', 'addon', 'marshal.workspace.sidebar', 'augment'),
      registration('@example/base', 'base', 'marshal.workspace.sidebar', 'fallback'),
    ]);

    expect(resolved(fallback, 'marshal.workspace.sidebar')).toMatchObject({
      mode: 'fallback',
      hostVisible: false,
    });
    expect(resolved(fallback, 'marshal.workspace.sidebar').registrations.map(({ action }) => action))
      .toEqual(['fallback', 'augment']);
  });

  it('accepts existing runtime UI application IDs but rejects extension-owned placements', () => {
    const applicationId: RuntimeExtensionUiApplication['id'] = 'Overlay Review / v1';
    const registry = new RuntimeExtensionUiPlacementRegistry(hostPlacements);

    expect(registry.resolve([
      registration('@example/overlay', applicationId, 'marshal.workspace', 'augment'),
    ]).diagnostics).toEqual([]);
    expect(() => registry.resolve([
      registration('@example/overlay', applicationId, 'extension.owned.placement', 'augment'),
    ])).toThrow('targets unknown placement');
  });

  it('uses one deterministic fallback only when host content is absent', () => {
    const resolution = new RuntimeExtensionUiPlacementRegistry(hostPlacements).resolve([
      registration(
        '@example/secondary',
        'secondary',
        'marshal.workspace.sidebar',
        'fallback',
      ),
      registration(
        '@example/primary',
        'primary',
        'marshal.workspace.sidebar',
        'fallback',
      ),
      registration(
        '@example/dormant',
        'dormant',
        'marshal.workspace.sidebar.footer',
        'fallback',
      ),
    ]);

    expect(resolved(resolution, 'marshal.workspace.sidebar')).toMatchObject({
      placementId: 'marshal.workspace.sidebar',
      mode: 'fallback',
      hostVisible: false,
    });
    expect(resolved(resolution, 'marshal.workspace.sidebar').registrations).toHaveLength(1);
    expect(resolved(resolution, 'marshal.workspace.sidebar').registrations[0]?.extensionId)
      .toBe('@example/primary');
    expect(resolved(resolution, 'marshal.workspace.sidebar.footer')).toMatchObject({
      placementId: 'marshal.workspace.sidebar.footer',
      mode: 'host',
      registrations: [],
    });
  });

  it('detects exact replacement collisions with stable red-display diagnostics', () => {
    const resolution = new RuntimeExtensionUiPlacementRegistry(hostPlacements).resolve([
      registration('@example/zeta', 'zeta', 'marshal.workspace.sidebar', 'replace'),
      registration('@example/alpha', 'alpha', 'marshal.workspace.sidebar', 'replace'),
    ]);

    expect(resolved(resolution, 'marshal.workspace.sidebar').registrations[0]?.extensionId)
      .toBe('@example/alpha');
    expect(resolution.diagnostics).toEqual([{
      code: RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION,
      severity: 'red-display',
      message: 'Multiple extensions replace host UI placement "marshal.workspace.sidebar".',
      placementId: 'marshal.workspace.sidebar',
      extensionId: '@example/alpha',
      relatedIds: ['@example/zeta', 'zeta'],
      repairHint: 'Keep one replace registration at this placement; use augment for composable UI.',
    }]);
  });

  it('detects ancestor/descendant collisions from explicit parent IDs', () => {
    const resolution = new RuntimeExtensionUiPlacementRegistry(hostPlacements).resolve([
      {
        ...registration('@example/shell', 'shell', 'marshal.workspace', 'replace'),
        replacement: 'full',
      },
      registration(
        '@example/footer',
        'footer',
        'marshal.workspace.sidebar.footer',
        'augment',
      ),
    ]);

    expect(resolution.diagnostics).toEqual([{
      code: RUNTIME_EXTENSION_UI_PLACEMENT_ANCESTOR_DESCENDANT_COLLISION,
      severity: 'red-display',
      message: 'Full replacement of "marshal.workspace" collides with descendant placement '
        + '"marshal.workspace.sidebar.footer".',
      placementId: 'marshal.workspace',
      extensionId: '@example/shell',
      relatedIds: [
        'marshal.workspace.sidebar.footer',
        '@example/footer',
        'footer',
      ],
      repairHint: 'Remove the descendant registration or limit the ancestor replacement to its '
        + 'placement.',
    }]);
  });

  it('serializes diagnostics as stable machine-readable JSON', () => {
    const resolution = new RuntimeExtensionUiPlacementRegistry(hostPlacements).resolve([
      registration('@example/two', 'two', 'marshal.workspace', 'replace'),
      registration('@example/one', 'one', 'marshal.workspace', 'replace'),
    ]);

    expect(JSON.stringify(resolution.diagnostics)).toBe(
      '[{"code":"RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION",'
      + '"severity":"red-display",'
      + '"message":"Multiple extensions replace host UI placement \\"marshal.workspace\\".",'
      + '"placementId":"marshal.workspace","extensionId":"@example/one",'
      + '"relatedIds":["@example/two","two"],'
      + '"repairHint":"Keep one replace registration at this placement; use augment for '
      + 'composable UI."}]',
    );
  });

  it('supports full replacement by suppressing every descendant placement', () => {
    const resolution = new RuntimeExtensionUiPlacementRegistry(hostPlacements).resolve([{
      ...registration('@example/shell', 'shell', 'marshal.workspace', 'replace'),
      replacement: 'full',
    }]);

    expect(resolved(resolution, 'marshal.workspace')).toMatchObject({
      placementId: 'marshal.workspace',
      mode: 'replace',
      hostVisible: false,
    });
    for (const placementId of [
      'marshal.workspace.sidebar',
      'marshal.workspace.sidebar.footer',
    ]) {
      expect(resolved(resolution, placementId)).toMatchObject({
        placementId,
        mode: 'empty',
        hostVisible: false,
        suppressedBy: {
          placementId: 'marshal.workspace',
          extensionId: '@example/shell',
          applicationId: 'shell',
        },
      });
    }
    expect(resolution.diagnostics).toEqual([]);
  });

  it('rejects invalid or cyclic host placement hierarchies', () => {
    expect(() => new RuntimeExtensionUiPlacementRegistry([{
      placementId: 'Marshal.Workspace',
      metadata: {
        title: 'Invalid',
        supportedActions: ['augment'],
      },
    }])).toThrow('canonical stable UI placement identifier');

    expect(() => new RuntimeExtensionUiPlacementRegistry([
      {
        placementId: 'marshal.one',
        parentPlacementId: 'marshal.two',
        metadata: {
          title: 'One',
          supportedActions: ['augment'],
        },
      },
      {
        placementId: 'marshal.two',
        parentPlacementId: 'marshal.one',
        metadata: {
          title: 'Two',
          supportedActions: ['augment'],
        },
      },
    ])).toThrow('ancestry contains a cycle');
  });
});

function registration(
  extensionId: string,
  applicationId: string,
  placementId: string,
  action: 'replace' | 'augment' | 'fallback',
): RuntimeExtensionUiPlacementRegistration {
  return { extensionId, applicationId, placementId, action };
}

function resolved(
  resolution: ReturnType<RuntimeExtensionUiPlacementRegistry['resolve']>,
  placementId: string,
) {
  const placement = resolution.placements.find(
    (candidate) => candidate.placementId === placementId,
  );
  if (!placement) throw new Error(`Missing resolved placement: ${placementId}`);
  return placement;
}
