interface RuntimeContext {
  runtime: { invoke(capability: string, input: unknown): Promise<unknown> };
}

interface RefinementInput {
  projectName: string;
  directionId: string;
  frameId: string;
  instruction: string;
  expectedVersion: number;
}

interface LoadInput {
  projectName: string;
}

interface SaveInput {
  workspace: unknown;
}

interface ResponsiveFrame {
  id: string;
  label: string;
  width: number;
  height: number;
  notes?: string;
  refinement?: string;
  updatedAt?: string;
}

interface ResponsiveState {
  selectedFrameId: string;
  frames: ResponsiveFrame[];
}

interface DesignDirection {
  id: string;
  name: string;
  premise: string;
  palette: [string, string, string];
  interaction: string;
  responsive?: ResponsiveState;
  tokens?: Record<string, string>;
}

interface DesignWorkspace {
  projectName: string;
  brief?: string;
  version: number;
  selectedDirectionId: string;
  directions: DesignDirection[];
  updatedAt: string;
}

interface ArtifactRead {
  path: string;
  content: string;
  encoding: string;
  sizeBytes: number;
  scope: Record<string, string>;
}

const WORKSPACE_PATH = 'design-studio/workspace.json';
const MAX_WORKSPACE_BYTES = 100_000;

export default async function refineDesign(input: RefinementInput, context: RuntimeContext) {
  const projectName = boundedString(input.projectName, 'projectName', 128);
  const directionId = identifier(input.directionId, 'directionId');
  const frameId = identifier(input.frameId, 'frameId');
  const instruction = boundedString(input.instruction, 'instruction', 4_000);
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion');
  const loaded = await readWorkspace(projectName, context);
  const workspace = loaded.workspace;
  if (workspace.version !== expectedVersion) {
    throw new Error(`Design workspace version conflict: expected ${expectedVersion}, found ${workspace.version}.`);
  }
  if (workspace.selectedDirectionId !== directionId) {
    throw new Error('Targeted refinement must address the workspace selected direction.');
  }
  const selectedIndex = workspace.directions.findIndex((direction) => direction.id === directionId);
  if (selectedIndex < 0) throw new Error('The selected design direction is unavailable.');
  const selected = workspace.directions[selectedIndex]!;
  if (!selected.responsive || selected.responsive.selectedFrameId !== frameId) {
    throw new Error('Targeted refinement must address the selected responsive frame.');
  }
  const frameIndex = selected.responsive.frames.findIndex((frame) => frame.id === frameId);
  if (frameIndex < 0) throw new Error('The selected responsive frame is unavailable.');

  const updatedAt = new Date().toISOString();
  const frames = selected.responsive.frames.map((frame, index) => index === frameIndex
    ? { ...frame, refinement: instruction, updatedAt }
    : frame);
  const directions = workspace.directions.map((direction, index) => index === selectedIndex
    ? { ...direction, responsive: { ...selected.responsive!, frames } }
    : direction);
  const updatedWorkspace: DesignWorkspace = {
    ...workspace,
    version: workspace.version + 1,
    directions,
    updatedAt,
  };
  const artifact = await writeWorkspace(updatedWorkspace, context);
  return {
    workspace: updatedWorkspace,
    artifact,
    refinement: {
      projectName,
      directionId,
      frameId,
      instruction,
      editBoundary: 'selected-direction-responsive-frame-only',
      previousVersion: workspace.version,
      nextVersion: updatedWorkspace.version,
      updatedAt,
    },
  };
}

export async function loadDesign(input: LoadInput, context: RuntimeContext) {
  const projectName = boundedString(input.projectName, 'projectName', 128);
  return readWorkspace(projectName, context);
}

export async function saveDesign(input: SaveInput, context: RuntimeContext) {
  const workspace = parseWorkspace(input.workspace);
  const artifact = await writeWorkspace(workspace, context);
  return { workspace, artifact };
}

async function readWorkspace(projectName: string, context: RuntimeContext): Promise<{
  workspace: DesignWorkspace;
  artifact: ArtifactRead;
}> {
  const rawArtifact = asRecord(await context.runtime.invoke('artifacts.read', {
    path: WORKSPACE_PATH,
    scope: 'project',
    encoding: 'utf8',
  }), 'artifacts.read output');
  const content = boundedString(rawArtifact.content, 'artifact.content', MAX_WORKSPACE_BYTES);
  if (rawArtifact.path !== WORKSPACE_PATH || rawArtifact.encoding !== 'utf8') {
    throw new Error('Design workspace artifact identity is invalid.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new Error('Design workspace artifact is not valid JSON.');
  }
  const workspace = parseWorkspace(decoded);
  if (workspace.projectName !== projectName) {
    throw new Error('Design workspace project identity does not match the requested project.');
  }
  return {
    workspace,
    artifact: {
      path: WORKSPACE_PATH,
      content,
      encoding: 'utf8',
      sizeBytes: nonNegativeInteger(rawArtifact.sizeBytes, 'artifact.sizeBytes'),
      scope: stringRecord(rawArtifact.scope, 'artifact.scope', 8),
    },
  };
}

async function writeWorkspace(workspace: DesignWorkspace, context: RuntimeContext): Promise<unknown> {
  const content = JSON.stringify(workspace, null, 2);
  if (content.length > MAX_WORKSPACE_BYTES) throw new Error('Design workspace exceeds its persistence bound.');
  return context.runtime.invoke('artifacts.write', {
    path: WORKSPACE_PATH,
    scope: 'project',
    content,
    mediaType: 'application/json',
    overwrite: true,
  });
}

function parseWorkspace(value: unknown): DesignWorkspace {
  const record = asRecord(value, 'workspace');
  const projectName = boundedString(record.projectName, 'workspace.projectName', 128);
  const brief = record.brief === undefined ? undefined : boundedString(record.brief, 'workspace.brief', 4_000);
  const version = positiveInteger(record.version, 'workspace.version');
  const selectedDirectionId = identifier(record.selectedDirectionId, 'workspace.selectedDirectionId');
  const updatedAt = isoTimestamp(record.updatedAt, 'workspace.updatedAt');
  if (!Array.isArray(record.directions) || record.directions.length < 1 || record.directions.length > 12) {
    throw new TypeError('workspace.directions must contain 1-12 directions.');
  }
  const directions = record.directions.map((direction, index) => parseDirection(direction, index));
  unique(directions.map((direction) => direction.id), 'workspace direction id');
  if (!directions.some((direction) => direction.id === selectedDirectionId)) {
    throw new TypeError('workspace.selectedDirectionId must identify a direction.');
  }
  return {
    projectName,
    ...(brief ? { brief } : {}),
    version,
    selectedDirectionId,
    directions,
    updatedAt,
  };
}

function parseDirection(value: unknown, index: number): DesignDirection {
  const record = asRecord(value, `workspace.directions[${index}]`);
  const palette = record.palette;
  if (!Array.isArray(palette) || palette.length !== 3 || palette.some((color) => typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new TypeError(`workspace.directions[${index}].palette must contain exactly three hex colors.`);
  }
  return {
    id: identifier(record.id, `workspace.directions[${index}].id`),
    name: boundedString(record.name, `workspace.directions[${index}].name`, 80),
    premise: boundedString(record.premise, `workspace.directions[${index}].premise`, 800),
    palette: palette.map((color) => String(color)) as [string, string, string],
    interaction: boundedString(record.interaction, `workspace.directions[${index}].interaction`, 800),
    ...(record.responsive === undefined ? {} : { responsive: parseResponsive(record.responsive, index) }),
    ...(record.tokens === undefined ? {} : { tokens: stringRecord(record.tokens, `workspace.directions[${index}].tokens`, 64) }),
  };
}

function parseResponsive(value: unknown, directionIndex: number): ResponsiveState {
  const record = asRecord(value, `workspace.directions[${directionIndex}].responsive`);
  const selectedFrameId = identifier(record.selectedFrameId, 'responsive.selectedFrameId');
  if (!Array.isArray(record.frames) || record.frames.length < 1 || record.frames.length > 8) {
    throw new TypeError('responsive.frames must contain 1-8 frames.');
  }
  const frames = record.frames.map((value, index): ResponsiveFrame => {
    const frame = asRecord(value, `responsive.frames[${index}]`);
    return {
      id: identifier(frame.id, `responsive.frames[${index}].id`),
      label: boundedString(frame.label, `responsive.frames[${index}].label`, 80),
      width: boundedInteger(frame.width, `responsive.frames[${index}].width`, 240, 8_192),
      height: boundedInteger(frame.height, `responsive.frames[${index}].height`, 240, 8_192),
      ...(frame.notes === undefined ? {} : { notes: boundedString(frame.notes, `responsive.frames[${index}].notes`, 800) }),
      ...(frame.refinement === undefined ? {} : { refinement: boundedString(frame.refinement, `responsive.frames[${index}].refinement`, 4_000) }),
      ...(frame.updatedAt === undefined ? {} : { updatedAt: isoTimestamp(frame.updatedAt, `responsive.frames[${index}].updatedAt`) }),
    };
  });
  unique(frames.map((frame) => frame.id), 'responsive frame id');
  if (!frames.some((frame) => frame.id === selectedFrameId)) {
    throw new TypeError('responsive.selectedFrameId must identify a frame.');
  }
  return { selectedFrameId, frames };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string, maxEntries: number): Record<string, string> {
  const record = asRecord(value, label);
  const entries = Object.entries(record);
  if (entries.length > maxEntries) throw new TypeError(`${label} exceeds ${maxEntries} entries.`);
  return Object.fromEntries(entries.map(([key, child]) => [
    identifier(key, `${label} key`),
    boundedString(child, `${label}.${key}`, 256),
  ]));
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const result = boundedString(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new TypeError(`${label} is invalid.`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function isoTimestamp(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return result;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label}s must be unique.`);
}
