import type { UiActionDeclaration, UiApplicationManifest, UiDeclaredToolReference, UiModuleActionTarget } from './applicationTypes.js';
import { validateUiHostFeatures } from './hostInteraction.js';

export function validateUiApplicationManifest(value: unknown): UiApplicationManifest {
  if (!isRecord(value)) throw new Error('application must be an object');
  if (value.version !== '1.0.0') throw new Error('application.version must be 1.0.0');
  const modes = stringArray(value.presentationModes, 'application.presentationModes');
  if (modes.length === 0 || !modes.includes('inline') || modes.some((mode) => !['inline', 'fullscreen', 'pip'].includes(mode))) {
    throw new Error('application.presentationModes must contain inline and only supported modes');
  }
  const actions = array(value.actions, 'application.actions').map(validateAction);
  const tools = array(value.tools, 'application.tools').map(validateTool);
  unique(actions.map((item) => item.id), 'action');
  unique(tools.map((item) => item.id), 'tool');
  const localState = value.localState === undefined ? undefined : validateLocalState(value.localState);
  const authoritativeState = value.authoritativeState === undefined ? undefined : validateAuthoritativeState(value.authoritativeState);
  const authoringProfile = value.authoringProfile === undefined ? undefined : validateProfile(value.authoringProfile);
  if (value.wantsImages !== undefined && typeof value.wantsImages !== 'boolean') {
    throw new Error('application.wantsImages must be a boolean');
  }
  return JSON.parse(JSON.stringify({
    version: '1.0.0',
    presentationModes: [...new Set(modes)],
    actions,
    tools,
    ...(localState ? { localState } : {}),
    ...(authoritativeState ? { authoritativeState } : {}),
    ...(authoringProfile ? { authoringProfile } : {}),
    ...(value.wantsImages === undefined ? {} : { wantsImages: value.wantsImages }),
    ...(value.hostFeatures === undefined ? {} : { hostFeatures: validateUiHostFeatures(value.hostFeatures) }),
  })) as UiApplicationManifest;
}

function validateAction(value: unknown): UiActionDeclaration {
  if (!isRecord(value)) throw new Error('application action must be an object');
  const id = identifier(value.id, 'action.id');
  const target = validateTarget(value.target);
  const allowedScopes = stringArray(value.allowedScopes, `${id}.allowedScopes`);
  if (allowedScopes.length === 0 || allowedScopes.some((scope) => !['session', 'project', 'workspace'].includes(scope))) {
    throw new Error(`${id}.allowedScopes is invalid`);
  }
  const risk = value.risk;
  if (risk !== 'read' && risk !== 'write' && risk !== 'external-effect') throw new Error(`${id}.risk is invalid`);
  const idempotency = value.idempotency;
  if (idempotency !== 'required' && idempotency !== 'supported' && idempotency !== 'none') throw new Error(`${id}.idempotency is invalid`);
  return {
    id,
    version: text(value.version, `${id}.version`),
    ...(value.title === undefined ? {} : { title: text(value.title, `${id}.title`) }),
    ...(value.description === undefined ? {} : { description: text(value.description, `${id}.description`) }),
    target,
    inputSchema: schema(value.inputSchema, `${id}.inputSchema`),
    outputSchema: schema(value.outputSchema, `${id}.outputSchema`),
    allowedScopes: [...new Set(allowedScopes)] as UiActionDeclaration['allowedScopes'],
    requiredPermissions: stringArray(value.requiredPermissions, `${id}.requiredPermissions`),
    risk,
    idempotency,
  };
}

function validateTool(value: unknown): UiDeclaredToolReference {
  if (!isRecord(value)) throw new Error('application tool must be an object');
  const id = identifier(value.id, 'tool.id');
  return {
    id,
    name: identifier(value.name, `${id}.name`, true),
    inputSchema: schema(value.inputSchema, `${id}.inputSchema`),
    ...(value.outputSchema === undefined ? {} : { outputSchema: schema(value.outputSchema, `${id}.outputSchema`) }),
  };
}

function validateTarget(value: unknown): UiActionDeclaration['target'] {
  if (!isRecord(value)) throw new Error('action.target must be an object');
  if (value.kind === 'capability') return { kind: 'capability', capability: identifier(value.capability, 'target.capability', true) };
  if (value.kind !== 'module' || !isRecord(value.module) || value.module.kind === 'inline') {
    throw new Error('action.target must reference a capability or editable workspace/artifact module');
  }
  const kind = value.module.kind;
  if (kind !== 'workspace_file' && kind !== 'artifact') throw new Error('action module kind is invalid');
  const module: UiModuleActionTarget['module'] = kind === 'workspace_file'
    ? { kind: 'workspace_file', path: text(value.module.path, 'target.module.path'), ...(value.module.export === undefined ? {} : { export: text(value.module.export, 'target.module.export') }) }
    : { kind: 'artifact', path: text(value.module.path, 'target.module.path'), ...(value.module.scope === undefined ? {} : { scope: stateScope(value.module.scope, 'target.module.scope') }), ...(value.module.export === undefined ? {} : { export: text(value.module.export, 'target.module.export') }) };
  return { kind: 'module', module, ...(value.executorCapability === undefined ? {} : { executorCapability: identifier(value.executorCapability, 'target.executorCapability', true) }) };
}

function validateLocalState(value: unknown): NonNullable<UiApplicationManifest['localState']> {
  if (!isRecord(value) || !['session', 'project', 'workspace'].includes(String(value.scope))) throw new Error('application.localState is invalid');
  return { scope: value.scope as 'session' | 'project' | 'workspace', schemaVersion: text(value.schemaVersion, 'application.localState.schemaVersion') };
}

function validateAuthoritativeState(value: unknown): NonNullable<UiApplicationManifest['authoritativeState']> {
  if (!isRecord(value)) throw new Error('application.authoritativeState is invalid');
  return { capability: identifier(value.capability, 'authoritativeState.capability', true), resourceId: text(value.resourceId, 'authoritativeState.resourceId'), version: text(value.version, 'authoritativeState.version') };
}

function validateProfile(value: unknown): NonNullable<UiApplicationManifest['authoringProfile']> {
  if (!isRecord(value)) throw new Error('application.authoringProfile is invalid');
  return { id: identifier(value.id, 'authoringProfile.id'), version: text(value.version, 'authoringProfile.version') };
}

function schema(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function stringArray(value: unknown, label: string): string[] { return array(value, label).map((item) => text(item, label)); }
function text(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`); return value; }
function identifier(value: unknown, label: string, dotted = false): string { const result = text(value, label); const pattern = dotted ? /^[a-zA-Z0-9_.:-]+$/ : /^[a-zA-Z0-9_-]+$/; if (!pattern.test(result)) throw new Error(`${label} has invalid characters`); return result; }
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} declaration`); }
function stateScope(value: unknown, label: string): 'workspace' | 'project' | 'session' { if (value !== 'workspace' && value !== 'project' && value !== 'session') throw new Error(`${label} is invalid`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
