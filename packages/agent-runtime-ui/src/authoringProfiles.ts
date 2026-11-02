import type {
  UiAuthoringProfile,
  UiAuthoringProfileProvenance,
  UiAuthoringProfileReference,
  UiHostCapabilities,
} from './applicationTypes.js';

export const STANDARDS_ONLY_UI_PROFILE: UiAuthoringProfile = Object.freeze({
  id: 'marshal-standards',
  version: '1.0.0',
  portable: true,
  packageImports: [],
  designTokens: {},
  templates: [],
  authoringGuidance: 'Use custom React and standardized MCP Apps CSS variables. Do not assume a host-owned component library.',
  accessibilityRequirements: [
    'Meet WCAG 2.2 AA for contrast, keyboard access, focus visibility, names, and status announcements.',
    'Honor reduced-motion and zoom without hiding controls or content.',
  ],
  layoutConstraints: [
    'Keep inline usable from 320 CSS pixels and adapt to host container dimensions and safe-area insets.',
    'Treat fullscreen and picture-in-picture as optional negotiated modes, never as required layout assumptions.',
  ],
  requiredHostCapabilities: [],
  optionalHostExtensions: [],
});

export interface UiAuthoringProfileSelection {
  profile: UiAuthoringProfile;
  requested?: { id: string; version?: string };
  status: 'selected' | 'fallback';
  origin: 'explicit' | 'preferred' | 'standards-default' | 'fallback';
  routingGuidance: string;
  reason?: string;
}

export interface UiAuthoringProfileRegistryOptions {
  profiles?: readonly UiAuthoringProfile[];
  preferred?: { id: string; version?: string };
}

/** Adapter-authored profiles are optional metadata; the standards profile is always present. */
export class UiAuthoringProfileRegistry {
  private readonly profiles = new Map<string, UiAuthoringProfile>();
  private readonly preferred?: { id: string; version?: string };

  constructor(options: readonly UiAuthoringProfile[] | UiAuthoringProfileRegistryOptions = []) {
    const configured: UiAuthoringProfileRegistryOptions = Array.isArray(options)
      ? { profiles: options as readonly UiAuthoringProfile[] }
      : options as UiAuthoringProfileRegistryOptions;
    const profiles = configured.profiles ?? [];
    this.add(STANDARDS_ONLY_UI_PROFILE);
    for (const profile of profiles) this.add(profile);
    this.preferred = normalizeRequested(configured.preferred);
  }

  list(): readonly UiAuthoringProfile[] {
    return [...this.profiles.values()].map(cloneProfile);
  }

  select(
    requested: { id: string; version?: string } | undefined,
    host: UiHostCapabilities,
  ): UiAuthoringProfileSelection {
    const explicit = normalizeRequested(requested);
    const selectionRequest = explicit ?? this.preferred;
    if (!selectionRequest) {
      const profile = cloneProfile(STANDARDS_ONLY_UI_PROFILE);
      return {
        profile,
        status: 'selected',
        origin: 'standards-default',
        routingGuidance: routingGuidance(profile),
      };
    }
    const profile = this.profiles.get(selectionRequest.id);
    if (!profile || (selectionRequest.version && selectionRequest.version !== profile.version)) {
      return {
        profile: cloneProfile(STANDARDS_ONLY_UI_PROFILE),
        requested: selectionRequest,
        status: 'fallback',
        origin: 'fallback',
        routingGuidance: routingGuidance(STANDARDS_ONLY_UI_PROFILE, selectionRequest),
        reason: 'Requested authoring profile is unavailable.',
      };
    }
    const missing = profile.requiredHostCapabilities.filter((capability) => !hostCapability(host, capability));
    if (missing.length > 0) {
      return {
        profile: cloneProfile(STANDARDS_ONLY_UI_PROFILE),
        requested: selectionRequest,
        status: 'fallback',
        origin: 'fallback',
        routingGuidance: routingGuidance(STANDARDS_ONLY_UI_PROFILE, selectionRequest),
        reason: `Host does not advertise: ${missing.join(', ')}.`,
      };
    }
    return {
      profile: cloneProfile(profile),
      requested: selectionRequest,
      status: 'selected',
      origin: explicit ? 'explicit' : 'preferred',
      routingGuidance: routingGuidance(profile),
    };
  }

  private add(profile: UiAuthoringProfile): void {
    validateProfile(profile);
    if (this.profiles.has(profile.id)) throw new Error(`Duplicate UI authoring profile: ${profile.id}`);
    this.profiles.set(profile.id, normalizeProfile(profile));
  }
}

export function authoringProfileProvenance(
  selection: UiAuthoringProfileSelection,
): UiAuthoringProfileProvenance {
  return {
    id: selection.profile.id,
    version: selection.profile.version,
    status: selection.status,
    origin: selection.origin,
    packageImports: [...selection.profile.packageImports],
    ...(selection.requested ? { requested: { ...selection.requested } } : {}),
    ...(selection.reason ? { reason: selection.reason } : {}),
  };
}

export function authoringProfileReference(
  profile: UiAuthoringProfile | UiAuthoringProfileProvenance,
): UiAuthoringProfileReference {
  return { id: profile.id, version: profile.version };
}

function hostCapability(host: UiHostCapabilities, path: string): boolean {
  let current: unknown = host;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === true || (typeof current === 'object' && current !== null);
}

function cloneProfile(profile: UiAuthoringProfile): UiAuthoringProfile {
  return {
    ...profile,
    packageImports: [...profile.packageImports],
    ...(profile.packageVersions ? { packageVersions: { ...profile.packageVersions } } : {}),
    designTokens: { ...profile.designTokens },
    templates: [...profile.templates],
    accessibilityRequirements: [...profile.accessibilityRequirements],
    layoutConstraints: [...profile.layoutConstraints],
    requiredHostCapabilities: [...profile.requiredHostCapabilities],
    optionalHostExtensions: [...profile.optionalHostExtensions],
  };
}

function normalizeProfile(profile: UiAuthoringProfile): UiAuthoringProfile {
  return cloneProfile({
    ...profile,
    packageImports: profile.packageImports.map(packageName),
    ...(profile.packageVersions
      ? {
        packageVersions: Object.fromEntries(
          Object.entries(profile.packageVersions).map(([name, version]) => [packageName(name), version]),
        ),
      }
      : {}),
  });
}

function normalizeRequested(
  requested: { id: string; version?: string } | undefined,
): { id: string; version?: string } | undefined {
  if (!requested) return undefined;
  const id = boundedIdentifier(requested.id, 'authoring profile id');
  const version = requested.version === undefined
    ? undefined
    : boundedText(requested.version, 'authoring profile version');
  return { id, ...(version ? { version } : {}) };
}

function validateProfile(profile: UiAuthoringProfile): void {
  boundedIdentifier(profile.id, 'UI authoring profile id');
  boundedText(profile.version, 'UI authoring profile version');
  boundedText(profile.authoringGuidance, 'UI authoring profile guidance');
  if (!Array.isArray(profile.packageImports) || profile.packageImports.length > 256) {
    throw new Error('UI authoring profile packageImports must contain at most 256 entries');
  }
  const imports = new Set<string>();
  for (const packageImport of profile.packageImports) {
    const normalized = packageName(packageImport);
    if (normalized === '*' || imports.has(normalized)) {
      throw new Error(`Invalid or duplicate UI authoring profile package import: ${packageImport}`);
    }
    imports.add(normalized);
  }
  const versionNames = new Set<string>();
  for (const [name, version] of Object.entries(profile.packageVersions ?? {})) {
    const normalized = packageName(name);
    if (!imports.has(normalized)) {
      throw new Error(`UI authoring profile version was declared for unavailable package: ${name}`);
    }
    if (versionNames.has(normalized)) {
      throw new Error(`Duplicate normalized UI authoring profile package version: ${normalized}`);
    }
    versionNames.add(normalized);
    boundedText(version, `UI authoring package version ${name}`);
  }
  for (const capability of profile.requiredHostCapabilities) {
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(capability)) {
      throw new Error(`Invalid UI host capability path: ${capability}`);
    }
  }
  validateGuidanceList(profile.accessibilityRequirements, 'accessibilityRequirements');
  validateGuidanceList(profile.layoutConstraints, 'layoutConstraints');
}

function validateGuidanceList(value: readonly string[], field: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(`UI authoring profile ${field} must contain 1-64 entries`);
  }
  for (const entry of value) boundedText(entry, `UI authoring profile ${field} entry`);
}

function routingGuidance(
  profile: UiAuthoringProfile,
  unavailable?: { id: string; version?: string },
): string {
  return [
    'Before authoring TSX, list UI authoring profiles and select the intended profile.',
    `Author against the selected ${profile.id}@${profile.version} profile only.`,
    `Allowed package roots: ${profile.packageImports.length ? profile.packageImports.join(', ') : 'none (custom React/CSS only)'}.`,
    `Consume its authoringGuidance, designTokens, templates, accessibilityRequirements, and layoutConstraints before writing source.`,
    unavailable ? `The requested ${unavailable.id}${unavailable.version ? `@${unavailable.version}` : ''} profile is unavailable; do not use its packages or assumptions.` : '',
  ].filter(Boolean).join(' ');
}

function packageName(value: string): string {
  const text = boundedText(value, 'UI authoring profile package import');
  const [first, second] = text.split('/');
  const name = first.startsWith('@') ? `${first}/${second ?? ''}` : first;
  if (!/^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/.test(name)) {
    throw new Error(`Invalid UI authoring profile package import: ${value}`);
  }
  return name;
}

function boundedIdentifier(value: string, field: string): string {
  const text = boundedText(value, field);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`${field} has invalid characters`);
  return text;
}

function boundedText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`${field} must be 1-512 characters`);
  }
  return value;
}
