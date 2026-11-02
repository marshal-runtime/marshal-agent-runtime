import { requireRuntimeExtensionIdentity } from './manifest.js';
import type { RuntimeExtensionUiApplication } from './contracts.js';

export const RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION =
  'RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION' as const;
export const RUNTIME_EXTENSION_UI_PLACEMENT_ANCESTOR_DESCENDANT_COLLISION =
  'RUNTIME_EXTENSION_UI_PLACEMENT_ANCESTOR_DESCENDANT_COLLISION' as const;
export const RUNTIME_EXTENSION_UI_PLACEMENT_DIAGNOSTIC_SEVERITY =
  'red-display' as const;

const MAX_HOST_PLACEMENTS = 512;
const MAX_REGISTRATIONS = 4_096;
const MAX_ID_LENGTH = 256;
const PLACEMENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?$/;
const ACTION_ORDER: Readonly<Record<RuntimeExtensionUiPlacementAction, number>> = {
  replace: 0,
  augment: 1,
  fallback: 2,
};

export type RuntimeExtensionUiPlacementAction = 'replace' | 'augment' | 'fallback';
export type RuntimeExtensionUiPlacementId = string;
export type RuntimeExtensionUiApplicationId = RuntimeExtensionUiApplication['id'];
export type RuntimeExtensionUiReplacementScope = 'placement' | 'full';
export type RuntimeExtensionUiPlacementDiagnosticCode =
  | typeof RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION
  | typeof RUNTIME_EXTENSION_UI_PLACEMENT_ANCESTOR_DESCENDANT_COLLISION;

export interface RuntimeExtensionUiHostPlacementMetadata {
  readonly title: string;
  readonly description?: string;
  readonly hasHostContent?: boolean;
  readonly supportedActions: readonly RuntimeExtensionUiPlacementAction[];
  readonly supportsFullReplacement?: boolean;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionUiHostPlacement {
  readonly placementId: RuntimeExtensionUiPlacementId;
  readonly parentPlacementId?: RuntimeExtensionUiPlacementId;
  readonly metadata: RuntimeExtensionUiHostPlacementMetadata;
}

interface RuntimeExtensionUiPlacementRegistrationBase {
  readonly extensionId: string;
  readonly applicationId: RuntimeExtensionUiApplicationId;
  readonly placementId: RuntimeExtensionUiPlacementId;
}

export interface RuntimeExtensionUiReplacePlacementRegistration
  extends RuntimeExtensionUiPlacementRegistrationBase {
  readonly action: 'replace';
  readonly replacement?: RuntimeExtensionUiReplacementScope;
}

export interface RuntimeExtensionUiAugmentPlacementRegistration
  extends RuntimeExtensionUiPlacementRegistrationBase {
  readonly action: 'augment';
}

export interface RuntimeExtensionUiFallbackPlacementRegistration
  extends RuntimeExtensionUiPlacementRegistrationBase {
  readonly action: 'fallback';
}

export type RuntimeExtensionUiPlacementRegistration =
  | RuntimeExtensionUiReplacePlacementRegistration
  | RuntimeExtensionUiAugmentPlacementRegistration
  | RuntimeExtensionUiFallbackPlacementRegistration;

export interface RuntimeExtensionUiPlacementDiagnostic {
  readonly code: RuntimeExtensionUiPlacementDiagnosticCode;
  readonly severity: typeof RUNTIME_EXTENSION_UI_PLACEMENT_DIAGNOSTIC_SEVERITY;
  readonly message: string;
  readonly placementId: RuntimeExtensionUiPlacementId;
  readonly extensionId: string;
  readonly relatedIds: readonly string[];
  readonly repairHint: string;
}

export type RuntimeExtensionUiPlacementResolutionMode =
  | 'host'
  | 'empty'
  | RuntimeExtensionUiPlacementAction;

export interface RuntimeExtensionUiPlacementSuppression {
  readonly placementId: RuntimeExtensionUiPlacementId;
  readonly extensionId: string;
  readonly applicationId: string;
}

export interface ResolvedRuntimeExtensionUiPlacement {
  readonly placementId: RuntimeExtensionUiPlacementId;
  readonly parentPlacementId?: RuntimeExtensionUiPlacementId;
  readonly metadata: RuntimeExtensionUiHostPlacementMetadata;
  readonly mode: RuntimeExtensionUiPlacementResolutionMode;
  readonly hostVisible: boolean;
  readonly registrations: readonly RuntimeExtensionUiPlacementRegistration[];
  readonly suppressedBy?: RuntimeExtensionUiPlacementSuppression;
}

export interface RuntimeExtensionUiPlacementRegistryResolution {
  readonly placements: readonly ResolvedRuntimeExtensionUiPlacement[];
  readonly diagnostics: readonly RuntimeExtensionUiPlacementDiagnostic[];
}

export class RuntimeExtensionUiPlacementRegistry {
  readonly #placements: readonly RuntimeExtensionUiHostPlacement[];
  readonly #placementById: ReadonlyMap<string, RuntimeExtensionUiHostPlacement>;
  readonly #ancestorIdsByPlacement: ReadonlyMap<string, readonly string[]>;

  constructor(placements: readonly RuntimeExtensionUiHostPlacement[]) {
    const normalized = normalizeHostPlacements(placements);
    this.#placements = normalized.placements;
    this.#placementById = normalized.placementById;
    this.#ancestorIdsByPlacement = normalized.ancestorIdsByPlacement;
  }

  listHostPlacements(): readonly RuntimeExtensionUiHostPlacement[] {
    return this.#placements;
  }

  resolve(
    registrations: readonly RuntimeExtensionUiPlacementRegistration[],
  ): RuntimeExtensionUiPlacementRegistryResolution {
    const normalized = normalizeRegistrations(registrations, this.#placementById);
    const byPlacement = groupRegistrations(normalized);
    const selectedReplacements = selectReplacements(byPlacement);
    const diagnostics = detectCollisions(
      normalized,
      byPlacement,
      this.#ancestorIdsByPlacement,
    );

    const placements = this.#placements.map((placement) => {
      const suppression = findSuppression(
        placement.placementId,
        selectedReplacements,
        this.#ancestorIdsByPlacement,
      );
      if (suppression) {
        return Object.freeze({
          placementId: placement.placementId,
          ...(placement.parentPlacementId
            ? { parentPlacementId: placement.parentPlacementId }
            : {}),
          metadata: placement.metadata,
          mode: 'empty' as const,
          hostVisible: false,
          registrations: Object.freeze([]),
          suppressedBy: Object.freeze({
            placementId: suppression.placementId,
            extensionId: suppression.extensionId,
            applicationId: suppression.applicationId,
          }),
        });
      }
      return resolvePlacement(placement, byPlacement.get(placement.placementId) ?? []);
    });

    return Object.freeze({
      placements: Object.freeze(placements),
      diagnostics,
    });
  }
}

export function createRuntimeExtensionUiPlacementRegistry(
  placements: readonly RuntimeExtensionUiHostPlacement[],
): RuntimeExtensionUiPlacementRegistry {
  return new RuntimeExtensionUiPlacementRegistry(placements);
}

export function resolveRuntimeExtensionUiPlacements(
  placements: readonly RuntimeExtensionUiHostPlacement[],
  registrations: readonly RuntimeExtensionUiPlacementRegistration[],
): RuntimeExtensionUiPlacementRegistryResolution {
  return new RuntimeExtensionUiPlacementRegistry(placements).resolve(registrations);
}

function normalizeHostPlacements(
  input: readonly RuntimeExtensionUiHostPlacement[],
): {
  readonly placements: readonly RuntimeExtensionUiHostPlacement[];
  readonly placementById: ReadonlyMap<string, RuntimeExtensionUiHostPlacement>;
  readonly ancestorIdsByPlacement: ReadonlyMap<string, readonly string[]>;
} {
  if (!Array.isArray(input) || input.length > MAX_HOST_PLACEMENTS) {
    throw new TypeError(`Host UI placements must contain at most ${MAX_HOST_PLACEMENTS} entries.`);
  }
  const placementById = new Map<string, RuntimeExtensionUiHostPlacement>();
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Host UI placement must be an object.');
    }
    const placementId = requirePlacementId(value.placementId, 'placementId');
    if (placementById.has(placementId)) {
      throw new TypeError(`Host UI placement "${placementId}" is duplicated.`);
    }
    const parentPlacementId = value.parentPlacementId === undefined
      ? undefined
      : requirePlacementId(value.parentPlacementId, 'parentPlacementId');
    if (parentPlacementId === placementId) {
      throw new TypeError(`Host UI placement "${placementId}" cannot parent itself.`);
    }
    placementById.set(placementId, Object.freeze({
      placementId,
      ...(parentPlacementId ? { parentPlacementId } : {}),
      metadata: normalizeHostMetadata(value.metadata, placementId),
    }));
  }
  for (const placement of placementById.values()) {
    if (
      placement.parentPlacementId
      && !placementById.has(placement.parentPlacementId)
    ) {
      throw new TypeError(
        `Host UI placement "${placement.placementId}" has unknown parent `
        + `"${placement.parentPlacementId}".`,
      );
    }
  }
  const ancestorIdsByPlacement = new Map<string, readonly string[]>();
  for (const placement of placementById.values()) {
    const ancestors: string[] = [];
    const visited = new Set([placement.placementId]);
    let parentId = placement.parentPlacementId;
    while (parentId) {
      if (visited.has(parentId)) {
        throw new TypeError(`Host UI placement ancestry contains a cycle at "${parentId}".`);
      }
      visited.add(parentId);
      ancestors.push(parentId);
      parentId = placementById.get(parentId)?.parentPlacementId;
    }
    ancestorIdsByPlacement.set(placement.placementId, Object.freeze(ancestors));
  }
  const placements = orderHostPlacements(placementById);
  return {
    placements: Object.freeze(placements),
    placementById,
    ancestorIdsByPlacement,
  };
}

function normalizeHostMetadata(
  value: RuntimeExtensionUiHostPlacementMetadata,
  placementId: string,
): RuntimeExtensionUiHostPlacementMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Host UI placement "${placementId}" metadata must be an object.`);
  }
  if (
    typeof value.title !== 'string'
    || !value.title.trim()
    || value.title.length > 1_024
  ) {
    throw new TypeError(`Host UI placement "${placementId}" title is invalid.`);
  }
  if (
    value.description !== undefined
    && (typeof value.description !== 'string' || value.description.length > 4_096)
  ) {
    throw new TypeError(`Host UI placement "${placementId}" description is invalid.`);
  }
  if (
    value.hasHostContent !== undefined
    && typeof value.hasHostContent !== 'boolean'
  ) {
    throw new TypeError(`Host UI placement "${placementId}" hasHostContent is invalid.`);
  }
  if (
    value.supportsFullReplacement !== undefined
    && typeof value.supportsFullReplacement !== 'boolean'
  ) {
    throw new TypeError(
      `Host UI placement "${placementId}" supportsFullReplacement is invalid.`,
    );
  }
  if (
    !Array.isArray(value.supportedActions)
    || value.supportedActions.length === 0
    || value.supportedActions.some((action) => !isPlacementAction(action))
  ) {
    throw new TypeError(`Host UI placement "${placementId}" supportedActions are invalid.`);
  }
  const supportedActions = [
    ...new Set(value.supportedActions as readonly RuntimeExtensionUiPlacementAction[]),
  ].sort(
    (left, right) => ACTION_ORDER[left] - ACTION_ORDER[right],
  );
  if (
    value.supportsFullReplacement === true
    && !supportedActions.includes('replace')
  ) {
    throw new TypeError(
      `Host UI placement "${placementId}" cannot support full replacement without replace.`,
    );
  }
  if (
    value.attributes !== undefined
    && (!value.attributes
      || typeof value.attributes !== 'object'
      || Array.isArray(value.attributes))
  ) {
    throw new TypeError(`Host UI placement "${placementId}" attributes are invalid.`);
  }
  return Object.freeze({
    title: value.title,
    ...(value.description !== undefined ? { description: value.description } : {}),
    hasHostContent: value.hasHostContent !== false,
    supportedActions: Object.freeze(supportedActions),
    supportsFullReplacement: value.supportsFullReplacement === true,
    ...(value.attributes ? { attributes: Object.freeze({ ...value.attributes }) } : {}),
  });
}

function normalizeRegistrations(
  input: readonly RuntimeExtensionUiPlacementRegistration[],
  placementById: ReadonlyMap<string, RuntimeExtensionUiHostPlacement>,
): readonly RuntimeExtensionUiPlacementRegistration[] {
  if (!Array.isArray(input) || input.length > MAX_REGISTRATIONS) {
    throw new TypeError(
      `UI placement registrations must contain at most ${MAX_REGISTRATIONS} entries.`,
    );
  }
  const seen = new Set<string>();
  const registrations = input.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('UI placement registration must be an object.');
    }
    const extensionId = requireRuntimeExtensionIdentity(value.extensionId);
    const applicationId = requireApplicationId(value.applicationId);
    const placementId = requirePlacementId(value.placementId, 'placementId');
    const placement = placementById.get(placementId);
    if (!placement) {
      throw new TypeError(`UI placement registration targets unknown placement "${placementId}".`);
    }
    if (!isPlacementAction(value.action)) {
      throw new TypeError(`UI placement registration action for "${placementId}" is invalid.`);
    }
    if (!placement.metadata.supportedActions.includes(value.action)) {
      throw new TypeError(
        `Host UI placement "${placementId}" does not support "${value.action}".`,
      );
    }
    const replacement = value.action === 'replace'
      ? value.replacement ?? 'placement'
      : undefined;
    if (replacement !== undefined && replacement !== 'placement' && replacement !== 'full') {
      throw new TypeError(`UI placement replacement scope for "${placementId}" is invalid.`);
    }
    if (replacement === 'full' && !placement.metadata.supportsFullReplacement) {
      throw new TypeError(`Host UI placement "${placementId}" does not support full replacement.`);
    }
    const registrationKey = `${extensionId}\u0000${applicationId}\u0000${placementId}`;
    if (seen.has(registrationKey)) {
      throw new TypeError(
        `UI placement registration "${extensionId}/${applicationId}" is duplicated at `
        + `"${placementId}".`,
      );
    }
    seen.add(registrationKey);
    return Object.freeze({
      extensionId,
      applicationId,
      placementId,
      action: value.action,
      ...(replacement ? { replacement } : {}),
    }) as RuntimeExtensionUiPlacementRegistration;
  });
  registrations.sort(compareRegistrations);
  return Object.freeze(registrations);
}

function groupRegistrations(
  registrations: readonly RuntimeExtensionUiPlacementRegistration[],
): ReadonlyMap<string, readonly RuntimeExtensionUiPlacementRegistration[]> {
  const groups = new Map<string, RuntimeExtensionUiPlacementRegistration[]>();
  for (const registration of registrations) {
    const group = groups.get(registration.placementId) ?? [];
    group.push(registration);
    groups.set(registration.placementId, group);
  }
  return new Map(
    [...groups].map(([placementId, group]) => [placementId, Object.freeze(group)]),
  );
}

function selectReplacements(
  byPlacement: ReadonlyMap<string, readonly RuntimeExtensionUiPlacementRegistration[]>,
): ReadonlyMap<string, RuntimeExtensionUiReplacePlacementRegistration> {
  const selected = new Map<string, RuntimeExtensionUiReplacePlacementRegistration>();
  for (const [placementId, registrations] of byPlacement) {
    const replacement = registrations.find(
      (registration): registration is RuntimeExtensionUiReplacePlacementRegistration =>
        registration.action === 'replace',
    );
    if (replacement) selected.set(placementId, replacement);
  }
  return selected;
}

function resolvePlacement(
  placement: RuntimeExtensionUiHostPlacement,
  registrations: readonly RuntimeExtensionUiPlacementRegistration[],
): ResolvedRuntimeExtensionUiPlacement {
  const replacement = registrations.find(
    (registration): registration is RuntimeExtensionUiReplacePlacementRegistration =>
      registration.action === 'replace',
  );
  const augmentations = registrations.filter(
    (registration) => registration.action === 'augment',
  );
  if (replacement) {
    return resolvedPlacement(placement, 'replace', false, [replacement, ...augmentations]);
  }
  const fallback = registrations.find((registration) => registration.action === 'fallback');
  if (fallback && placement.metadata.hasHostContent === false) {
    return resolvedPlacement(placement, 'fallback', false, [fallback, ...augmentations]);
  }
  if (augmentations.length > 0) {
    return resolvedPlacement(
      placement,
      'augment',
      placement.metadata.hasHostContent !== false,
      augmentations,
    );
  }
  return resolvedPlacement(
    placement,
    placement.metadata.hasHostContent === false ? 'empty' : 'host',
    placement.metadata.hasHostContent !== false,
    [],
  );
}

function resolvedPlacement(
  placement: RuntimeExtensionUiHostPlacement,
  mode: RuntimeExtensionUiPlacementResolutionMode,
  hostVisible: boolean,
  registrations: readonly RuntimeExtensionUiPlacementRegistration[],
): ResolvedRuntimeExtensionUiPlacement {
  return Object.freeze({
    placementId: placement.placementId,
    ...(placement.parentPlacementId
      ? { parentPlacementId: placement.parentPlacementId }
      : {}),
    metadata: placement.metadata,
    mode,
    hostVisible,
    registrations: Object.freeze([...registrations]),
  });
}

function findSuppression(
  placementId: string,
  selectedReplacements: ReadonlyMap<string, RuntimeExtensionUiReplacePlacementRegistration>,
  ancestorIdsByPlacement: ReadonlyMap<string, readonly string[]>,
): RuntimeExtensionUiReplacePlacementRegistration | undefined {
  const ancestors = ancestorIdsByPlacement.get(placementId) ?? [];
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const replacement = selectedReplacements.get(ancestors[index] as string);
    if (replacement?.replacement === 'full') return replacement;
  }
  return undefined;
}

function detectCollisions(
  registrations: readonly RuntimeExtensionUiPlacementRegistration[],
  byPlacement: ReadonlyMap<string, readonly RuntimeExtensionUiPlacementRegistration[]>,
  ancestorIdsByPlacement: ReadonlyMap<string, readonly string[]>,
): readonly RuntimeExtensionUiPlacementDiagnostic[] {
  const diagnostics: RuntimeExtensionUiPlacementDiagnostic[] = [];
  for (const [placementId, group] of byPlacement) {
    const replacements = group.filter(
      (registration): registration is RuntimeExtensionUiReplacePlacementRegistration =>
        registration.action === 'replace',
    );
    if (replacements.length > 1) {
      const owner = replacements[0] as RuntimeExtensionUiReplacePlacementRegistration;
      diagnostics.push(diagnostic(
        RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION,
        placementId,
        owner.extensionId,
        replacements.slice(1).flatMap((registration) => [
          registration.extensionId,
          registration.applicationId,
        ]),
        'Keep one replace registration at this placement; use augment for composable UI.',
        `Multiple extensions replace host UI placement "${placementId}".`,
      ));
    }
  }
  for (const replacement of registrations) {
    if (replacement.action !== 'replace' || replacement.replacement !== 'full') continue;
    for (const registration of registrations) {
      if (
        registration.placementId === replacement.placementId
        || !(ancestorIdsByPlacement.get(registration.placementId) ?? [])
          .includes(replacement.placementId)
      ) {
        continue;
      }
      diagnostics.push(diagnostic(
        RUNTIME_EXTENSION_UI_PLACEMENT_ANCESTOR_DESCENDANT_COLLISION,
        replacement.placementId,
        replacement.extensionId,
        [
          registration.placementId,
          registration.extensionId,
          registration.applicationId,
        ],
        'Remove the descendant registration or limit the ancestor replacement to its placement.',
        `Full replacement of "${replacement.placementId}" collides with descendant placement `
        + `"${registration.placementId}".`,
      ));
    }
  }
  diagnostics.sort(compareDiagnostics);
  return Object.freeze(diagnostics);
}

function diagnostic(
  code: RuntimeExtensionUiPlacementDiagnosticCode,
  placementId: string,
  extensionId: string,
  relatedIds: readonly string[],
  repairHint: string,
  message: string,
): RuntimeExtensionUiPlacementDiagnostic {
  return Object.freeze({
    code,
    severity: RUNTIME_EXTENSION_UI_PLACEMENT_DIAGNOSTIC_SEVERITY,
    message,
    placementId,
    extensionId,
    relatedIds: Object.freeze([...relatedIds]),
    repairHint,
  });
}

function requirePlacementId(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_ID_LENGTH
    || value !== value.trim()
    || value !== value.normalize('NFC')
    || !PLACEMENT_ID_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical stable UI placement identifier.`);
  }
  return value;
}

function requireApplicationId(value: unknown): RuntimeExtensionUiApplicationId {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 1_024
  ) {
    throw new TypeError('applicationId must reference a valid runtime extension UI application.');
  }
  return value;
}

function isPlacementAction(value: unknown): value is RuntimeExtensionUiPlacementAction {
  return value === 'replace' || value === 'augment' || value === 'fallback';
}

function orderHostPlacements(
  placementById: ReadonlyMap<string, RuntimeExtensionUiHostPlacement>,
): readonly RuntimeExtensionUiHostPlacement[] {
  const rootIds: string[] = [];
  const childIdsByParent = new Map<string, string[]>();
  for (const placement of placementById.values()) {
    if (!placement.parentPlacementId) {
      rootIds.push(placement.placementId);
      continue;
    }
    const childIds = childIdsByParent.get(placement.parentPlacementId) ?? [];
    childIds.push(placement.placementId);
    childIdsByParent.set(placement.parentPlacementId, childIds);
  }
  rootIds.sort(compareText);
  for (const childIds of childIdsByParent.values()) childIds.sort(compareText);

  const placements: RuntimeExtensionUiHostPlacement[] = [];
  const visit = (placementId: string): void => {
    const placement = placementById.get(placementId);
    if (!placement) return;
    placements.push(placement);
    for (const childId of childIdsByParent.get(placementId) ?? []) visit(childId);
  };
  for (const rootId of rootIds) visit(rootId);
  return Object.freeze(placements);
}

function compareRegistrations(
  left: RuntimeExtensionUiPlacementRegistration,
  right: RuntimeExtensionUiPlacementRegistration,
): number {
  return compareText(left.placementId, right.placementId)
    || ACTION_ORDER[left.action] - ACTION_ORDER[right.action]
    || compareText(left.extensionId, right.extensionId)
    || compareText(left.applicationId, right.applicationId);
}

function compareDiagnostics(
  left: RuntimeExtensionUiPlacementDiagnostic,
  right: RuntimeExtensionUiPlacementDiagnostic,
): number {
  return compareText(left.placementId, right.placementId)
    || compareText(left.code, right.code)
    || compareText(left.extensionId, right.extensionId)
    || compareText(left.relatedIds.join('\u0000'), right.relatedIds.join('\u0000'));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
