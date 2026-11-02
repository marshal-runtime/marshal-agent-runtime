import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import {
  MARSHAL_CAPABILITY_MANIFEST,
  MARSHAL_MANIFEST_VERSION,
  projectNativeCallbackHints,
} from '@marshal/agent-runtime-manifest';
import type { RuntimePackageDeclaration } from '@marshal/agent-runtime-host';
import { CODEX_PACKAGE_DECLARATIONS } from './packageDeclarations.js';

export interface CodexPluginProjectionOptions {
  readonly version?: string;
  /** Preauthorize bounded native-agent control without trusted Node imports. */
  readonly boundedAgentic?: boolean;
  /** Add authored React compilation to bounded agent control without wildcard imports. */
  readonly adaptiveAgentic?: boolean;
  readonly trustedLocal?: boolean;
  readonly packageDeclarations?: readonly RuntimePackageDeclaration[];
  /** Installation-local launch paths supplied only by the detachable adapter installer. */
  readonly runtimeLaunch?: CodexPluginRuntimeLaunch;
}

export interface CodexPluginRuntimeLaunch {
  readonly nodeExecutable: string;
  readonly serverEntrypoint: string;
  readonly hookEntrypoint: string;
  /** Optional detachable leaf-composition module loaded by the MIT server CLI. */
  readonly kernelModule?: string;
}

export interface InstallCodexPluginOptions extends CodexPluginProjectionOptions {
  readonly destination: string;
  readonly force?: boolean;
}

const PLUGIN_NAME = 'marshal-runtime';
const MANAGED_SKILLS_MANIFEST = '.marshal-plugin-managed.json';
const MANAGED_SKILLS_MANIFEST_VERSION = 1;
const MANAGED_SKILLS_TRANSACTION = '.marshal-plugin-transaction.json';
const MANAGED_SKILLS_TRANSACTION_DATA = '.marshal-plugin-transaction';
const MANAGED_SKILLS_TRANSACTION_VERSION = 1;
const CODEX_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODEX_SKILL_NAME_MAX_LENGTH = 64;
const CODEX_SKILL_DESCRIPTION_MAX_LENGTH = 1_024;
const GENERATED_PATH_MAX_LENGTH = 240;
const GENERATED_PATH_MAX_DEPTH = 8;
const GENERATED_PATH_SEGMENT_MAX_LENGTH = 120;
const MANAGED_MANIFEST_MAX_BYTES = 64 * 1_024;
const MANAGED_MANIFEST_MAX_ENTRIES = 256;
const MANAGED_TRANSACTION_MAX_BYTES = 512 * 1_024;
const MANAGED_SKILL_MAX_BYTES = 1_024 * 1_024;
const MANAGED_DIRECTORY_SCAN_MAX_ENTRIES = 1_024;
const MANAGED_TRANSACTION_SCAN_MAX_ENTRIES =
  MANAGED_MANIFEST_MAX_ENTRIES * GENERATED_PATH_MAX_DEPTH + 2;
const PLUGIN_INSTALL_TEST_FAULT_ENV = 'MARSHAL_RUNTIME_CODEX_PLUGIN_TEST_FAULT';
const TRANSACTION_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PORTABLE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._ -]+$/;
const WINDOWS_RESERVED_PATH_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

interface ManagedSkillFile {
  readonly path: string;
  readonly sha256: string;
}

interface ManagedSkillOperation {
  readonly path: string;
  readonly present: boolean;
}

interface ManagedSkillTransaction {
  readonly id: string;
  readonly generation: string;
  readonly previousManifest: boolean;
  readonly previous: ReadonlyMap<string, string>;
  readonly current: ReadonlyMap<string, string>;
  readonly retained: readonly ManagedSkillOperation[];
  readonly stale: readonly ManagedSkillOperation[];
}

type ManagedPathState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'blocked'; readonly blocker: string }
  | { readonly kind: 'directory' }
  | { readonly kind: 'file'; readonly sha256: string };

/** Project the portable manifest into the detachable Codex plugin surface. */
export function createCodexPluginFiles(
  options: CodexPluginProjectionOptions = {},
): Readonly<Record<string, string>> {
  const selectedProfiles = [
    options.boundedAgentic,
    options.adaptiveAgentic,
    options.trustedLocal,
  ].filter((selected) => selected === true).length;
  if (selectedProfiles > 1) {
    throw new Error('boundedAgentic, adaptiveAgentic, and trustedLocal are mutually exclusive plugin profiles.');
  }
  const runtimeLaunch = options.runtimeLaunch === undefined
    ? undefined
    : normalizeRuntimeLaunch(options.runtimeLaunch);
  const version = options.version ?? `0.1.0+manifest.${MARSHAL_MANIFEST_VERSION}`;
  const packageDeclarations = options.packageDeclarations ?? CODEX_PACKAGE_DECLARATIONS;
  const plugin = {
    name: PLUGIN_NAME,
    version,
    description: MARSHAL_CAPABILITY_MANIFEST.product.summary,
    author: { name: 'Marshal Contributors' },
    license: 'MIT',
    keywords: ['agents', 'capabilities', 'typescript', 'mcp-apps', 'runtime'],
    skills: './skills/',
    mcpServers: './.mcp.json',
    interface: {
      displayName: MARSHAL_CAPABILITY_MANIFEST.product.name,
      shortDescription: 'Composable capabilities, programmable execution, and adaptive applications.',
      longDescription: MARSHAL_CAPABILITY_MANIFEST.product.summary,
      developerName: 'Marshal Contributors',
      category: 'Productivity',
      capabilities: [
        'MCP Tools',
        'Lifecycle Hooks',
        'Editable TypeScript',
        'Interactive UI',
      ],
      defaultPrompt: [
        'Call runtime_extensions_manage now to open the Marshal Runtime Extensions manager. Do not inspect the repository or run GitNexus.',
        ...MARSHAL_CAPABILITY_MANIFEST.examples
          .filter((example) => example.kind === 'direct')
          .map((example) => example.prompt.slice(0, 128)),
      ].slice(0, 3),
    },
  };
  const mcp = {
    mcpServers: {
      'marshal-runtime': {
        command: runtimeLaunch?.nodeExecutable ?? 'agent-runtime-codex',
        ...(runtimeLaunch ? { args: [runtimeLaunch.serverEntrypoint] } : {}),
        env: {
          MARSHAL_RUNTIME_LIFECYCLE_TOOLS: 'hidden',
          ...(runtimeLaunch?.kernelModule ? {
            AGENT_RUNTIME_KERNEL_MODULE: runtimeLaunch.kernelModule,
          } : {}),
          ...(options.boundedAgentic === true ? {
              MARSHAL_RUNTIME_PERMISSION_PROFILE: 'bounded-agentic',
            } : {}),
          ...(options.adaptiveAgentic === true ? {
              MARSHAL_RUNTIME_PERMISSION_PROFILE: 'adaptive-agentic',
            } : {}),
          ...(options.trustedLocal === true ? {
              MARSHAL_RUNTIME_PERMISSION_PROFILE: 'trusted-local',
              MARSHAL_RUNTIME_ALLOWED_PACKAGES: '*',
              MARSHAL_RUNTIME_ALLOWED_BUILTINS: '*',
            } : {}),
        },
        // Codex authorizes the transport call automatically; Marshal's broker still
        // enforces the selected permission profile, scopes, bounds, and receipts.
        default_tools_approval_mode: 'approve',
        startup_timeout_sec: 20,
        tool_timeout_sec: 180,
      },
    },
  };
  const files = {
    '.codex-plugin/plugin.json': json(plugin),
    '.mcp.json': json(mcp),
    'hooks/hooks.json': json(projectCodexHooks(
      runtimeLaunch,
      packageDeclarations,
    )),
    ...projectPackageSkills(packageDeclarations),
  };
  assertPortableGeneratedPaths(Object.keys(files));
  return Object.freeze(files);
}

function normalizeGeneratedAbsolutePath(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || !path.isAbsolute(normalized) || /[\0\r\n]/u.test(normalized)) {
    throw new Error(`${field} must be an absolute path without control characters.`);
  }
  return path.resolve(normalized);
}

function projectPackageSkills(
  declarations: readonly RuntimePackageDeclaration[],
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const declaration of declarations) {
    for (const skill of declaration.skills ?? []) {
      const directory = skillDirectory(skill.id);
      const skillPath = `skills/${directory}/SKILL.md`;
      if (files[skillPath] !== undefined) {
        throw new Error(`Duplicate Codex skill path: ${skillPath}`);
      }
      files[skillPath] = projectCodexSkill(skill, directory);
      for (const reference of skill.references ?? []) {
        const referencePath = `skills/${directory}/references/${safeRelativeAssetPath(reference.path)}`;
        if (files[referencePath] !== undefined) {
          throw new Error(`Duplicate Codex skill reference path: ${referencePath}`);
        }
        files[referencePath] = reference.content.endsWith('\n')
          ? reference.content
          : `${reference.content}\n`;
      }
    }
  }
  const promptFragments = declarations
    .flatMap((declaration) => declaration.promptFragments ?? [])
    .sort(
      (left, right) =>
        (left.priority ?? 0) - (right.priority ?? 0)
        || left.id.localeCompare(right.id),
    );
  if (promptFragments.length > 0) {
    const runtimeSkill = 'skills/use-marshal-runtime/SKILL.md';
    if (!files[runtimeSkill]) {
      throw new Error('Package prompt fragments require the Marshal runtime skill.');
    }
    files[runtimeSkill] += [
      '',
      '## Installed package guidance',
      '',
      ...promptFragments.map((fragment) => fragment.content.trim()),
      '',
    ].join('\n');
  }
  return files;
}

function projectLegacyPackageSkills(
  declarations: readonly RuntimePackageDeclaration[],
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const declaration of declarations) {
    for (const skill of declaration.skills ?? []) {
      const directory = skillDirectory(skill.id);
      const skillPath = `skills/${directory}/SKILL.md`;
      if (files[skillPath] !== undefined) {
        throw new Error(`Duplicate legacy Codex skill path: ${skillPath}`);
      }
      files[skillPath] = withTrailingNewline(skill.content);
      for (const reference of skill.references ?? []) {
        const referencePath =
          `skills/${directory}/references/${safeRelativeAssetPath(reference.path)}`;
        if (files[referencePath] !== undefined) {
          throw new Error(`Duplicate legacy Codex skill reference path: ${referencePath}`);
        }
        files[referencePath] = withTrailingNewline(reference.content);
      }
    }
  }
  const promptFragments = declarations
    .flatMap((declaration) => declaration.promptFragments ?? [])
    .sort(
      (left, right) =>
        (left.priority ?? 0) - (right.priority ?? 0)
        || left.id.localeCompare(right.id),
    );
  if (promptFragments.length > 0) {
    const runtimeSkill = 'skills/use-marshal-runtime/SKILL.md';
    if (!files[runtimeSkill]) {
      throw new Error('Legacy package prompt fragments require the Marshal runtime skill.');
    }
    files[runtimeSkill] += [
      '',
      '## Installed package guidance',
      '',
      ...promptFragments.map((fragment) => fragment.content.trim()),
      '',
    ].join('\n');
  }
  assertPortableGeneratedPaths(Object.keys(files));
  return files;
}

function projectCodexSkill(
  skill: NonNullable<RuntimePackageDeclaration['skills']>[number],
  directory: string,
): string {
  const frontmatter = codexSkillFrontmatter(skill.content, skill.id);
  if (frontmatter) {
    validateCodexSkillMetadata(frontmatter, directory, skill.id);
    return withTrailingNewline(skill.content);
  }
  const description = skill.description.trim();
  validateCodexSkillMetadata({ name: directory, description }, directory, skill.id);
  return withTrailingNewline([
    '---',
    `name: ${JSON.stringify(directory)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    skill.content,
  ].join('\n'));
}

function codexSkillFrontmatter(content: string, skillId: string): Record<string, unknown> | undefined {
  if (!content.startsWith('---')) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new Error(`Codex skill ${skillId} has unterminated YAML frontmatter.`);
  }
  const document = parseDocument(match[1], {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`Codex skill ${skillId} has invalid YAML frontmatter: ${document.errors[0]!.message}`);
  }
  const metadata: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(metadata)) {
    throw new Error(`Codex skill ${skillId} YAML frontmatter must be a mapping.`);
  }
  return metadata;
}

function validateCodexSkillMetadata(
  metadata: Readonly<Record<string, unknown>>,
  directory: string,
  skillId: string,
): void {
  const name = metadata.name;
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.length > CODEX_SKILL_NAME_MAX_LENGTH
    || !CODEX_SKILL_NAME_PATTERN.test(name)
  ) {
    throw new Error(`Codex skill ${skillId} has an invalid name.`);
  }
  if (name !== directory) {
    throw new Error(`Codex skill ${skillId} name must match its directory (${directory}).`);
  }
  const description = metadata.description;
  if (
    typeof description !== 'string'
    || description.trim().length === 0
    || description.length > CODEX_SKILL_DESCRIPTION_MAX_LENGTH
  ) {
    throw new Error(`Codex skill ${skillId} has an invalid description.`);
  }
}

async function ensureRealDirectoryChain(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  assertContained(root, directory);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Plugin path is not a real directory: ${current}`);
    }
  }
}

function skillDirectory(id: string): string {
  if (id === 'marshal.runtime/use-marshal-runtime') return 'use-marshal-runtime';
  const normalized = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized || normalized.length > CODEX_SKILL_NAME_MAX_LENGTH) {
    throw new Error(`Invalid Codex skill id: ${id}`);
  }
  assertPortablePathSegment(normalized, `Codex skill id ${id}`);
  return normalized;
}

function safeRelativeAssetPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!portablePathSegments(normalized)) {
    throw new Error(`Invalid Codex skill asset path: ${value}`);
  }
  return normalized;
}

export async function installCodexPlugin(
  options: InstallCodexPluginOptions,
): Promise<{ root: string; files: readonly string[] }> {
  const root = path.resolve(options.destination);
  assertSafeInstallRoot(root);
  const existing = await existingEntries(root);
  if (existing.length > 0 && !options.force) {
    throw new Error('Plugin destination is not empty; pass force only when replacing generated files.');
  }
  await ensureRealDirectory(root);
  const files = createCodexPluginFiles(options);
  const current = managedSkillFiles(files);
  if (!options.force) {
    await writeGeneratedPluginFiles(root, files, false);
    await writeManagedSkillManifest(root, current, false);
    return { root, files: Object.keys(files).sort() };
  }

  const existingTransaction = await readManagedSkillTransaction(root);
  let transaction: ManagedSkillTransaction;
  if (existingTransaction) {
    if (
      existingTransaction.generation !== pluginGeneration(files)
      || !managedSkillMapsEqual(existingTransaction.current, current)
    ) {
      throw new Error(
        'An incomplete plugin transaction targets a different generated plugin; '
        + 'retry the interrupted generation before installing another one.',
      );
    }
    await validateManagedSkillTransactionManifest(root, existingTransaction);
    await validateManagedSkillTransactionData(root, existingTransaction);
    transaction = existingTransaction;
    if (await isManagedSkillTransactionCommitted(root, files, transaction)) {
      await removeManagedSkillTransaction(root, transaction);
      return { root, files: Object.keys(files).sort() };
    }
  } else {
    await assertNoManagedSkillTransactionData(root);
    const manifestManagedSkills = await readManagedSkillFiles(root);
    const previous = manifestManagedSkills
      ?? await readManifestlessManagedSkillFiles(root, current);
    transaction = await createManagedSkillTransaction(
      root,
      files,
      previous,
      current,
      manifestManagedSkills !== undefined,
    );
    await validateManagedSkillTransaction(root, transaction, false);
    await writeManagedSkillTransaction(root, transaction);
  }

  await reconcileManagedSkillTransaction(root, files, transaction);
  return { root, files: Object.keys(files).sort() };
}

function managedSkillFiles(files: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const managed = new Map(
    Object.entries(files)
      .filter(([relativePath]) => isManagedSkillPath(relativePath))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content]) => [relativePath, contentDigest(content)]),
  );
  if (managed.size > MANAGED_MANIFEST_MAX_ENTRIES) {
    throw new Error(
      `Generated plugin has too many managed skill files; maximum is ${MANAGED_MANIFEST_MAX_ENTRIES}.`,
    );
  }
  return managed;
}

async function writeGeneratedPluginFiles(
  root: string,
  files: Readonly<Record<string, string>>,
  overwrite: boolean,
): Promise<void> {
  for (const relativePath of Object.keys(files)) {
    const target = path.resolve(root, relativePath);
    assertContained(root, target);
    await ensureRealDirectoryChain(root, path.dirname(target));
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.resolve(root, relativePath);
    await atomicWrite(target, content, root, overwrite);
  }
}

async function writeManagedSkillManifest(
  root: string,
  managed: ReadonlyMap<string, string>,
  overwrite: boolean,
): Promise<void> {
  const target = path.resolve(root, MANAGED_SKILLS_MANIFEST);
  assertContained(root, target);
  await atomicWrite(target, json({
    version: MANAGED_SKILLS_MANIFEST_VERSION,
    files: managedSkillEntries(managed),
  }), root, overwrite);
}

async function writeManagedSkillTransaction(
  root: string,
  transaction: ManagedSkillTransaction,
): Promise<void> {
  const target = path.resolve(root, MANAGED_SKILLS_TRANSACTION);
  assertContained(root, target);
  const content = json({
    version: MANAGED_SKILLS_TRANSACTION_VERSION,
    id: transaction.id,
    generation: transaction.generation,
    previousManifest: transaction.previousManifest,
    previous: managedSkillEntries(transaction.previous),
    current: managedSkillEntries(transaction.current),
    retained: transaction.retained,
    stale: transaction.stale,
  });
  if (Buffer.byteLength(content, 'utf8') > MANAGED_TRANSACTION_MAX_BYTES) {
    throw new Error(
      `Managed plugin transaction exceeds the ${MANAGED_TRANSACTION_MAX_BYTES}-byte limit: ${target}`,
    );
  }
  await atomicWrite(target, content, root, false);
}

async function readManagedSkillFiles(
  root: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  const target = path.resolve(root, MANAGED_SKILLS_MANIFEST);
  const parsed = await readBoundedJsonObject(
    root,
    target,
    MANAGED_MANIFEST_MAX_BYTES,
    'Managed plugin manifest',
  );
  if (!parsed) return undefined;
  if (
    !hasExactKeys(parsed, ['files', 'version'])
    || parsed.version !== MANAGED_SKILLS_MANIFEST_VERSION
    || !Array.isArray(parsed.files)
  ) {
    throw new Error(`Managed plugin manifest has an unsupported shape: ${target}`);
  }
  return managedSkillMapFromEntries(
    parsed.files,
    MANAGED_MANIFEST_MAX_ENTRIES,
    target,
  );
}

async function readManagedSkillTransaction(
  root: string,
): Promise<ManagedSkillTransaction | undefined> {
  const target = path.resolve(root, MANAGED_SKILLS_TRANSACTION);
  const parsed = await readBoundedJsonObject(
    root,
    target,
    MANAGED_TRANSACTION_MAX_BYTES,
    'Managed plugin transaction',
  );
  if (!parsed) return undefined;
  if (
    !hasExactKeys(parsed, [
      'current',
      'generation',
      'id',
      'previous',
      'previousManifest',
      'retained',
      'stale',
      'version',
    ])
    || parsed.version !== MANAGED_SKILLS_TRANSACTION_VERSION
    || typeof parsed.id !== 'string'
    || !TRANSACTION_ID_PATTERN.test(parsed.id)
    || typeof parsed.generation !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.generation)
    || typeof parsed.previousManifest !== 'boolean'
    || !Array.isArray(parsed.previous)
    || !Array.isArray(parsed.current)
    || !Array.isArray(parsed.retained)
    || !Array.isArray(parsed.stale)
  ) {
    throw new Error(`Managed plugin transaction has an unsupported shape: ${target}`);
  }
  const previous = managedSkillMapFromEntries(
    parsed.previous,
    MANAGED_MANIFEST_MAX_ENTRIES,
    target,
  );
  const current = managedSkillMapFromEntries(
    parsed.current,
    MANAGED_MANIFEST_MAX_ENTRIES,
    target,
  );
  const retained = managedSkillOperationsFromEntries(parsed.retained, target);
  const stale = managedSkillOperationsFromEntries(parsed.stale, target);
  const transaction: ManagedSkillTransaction = {
    id: parsed.id,
    generation: parsed.generation,
    previousManifest: parsed.previousManifest,
    previous,
    current,
    retained,
    stale,
  };
  assertCrossGenerationPathCompatibility(previous, current);
  assertManagedSkillTransactionOperations(transaction, target);
  return transaction;
}

async function readBoundedJsonObject(
  root: string,
  target: string,
  maxBytes: number,
  label: string,
): Promise<Record<string, unknown> | undefined> {
  assertContained(root, target);
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!existing) return undefined;
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error(`Refusing to read unsafe ${label.toLowerCase()}: ${target}`);
  }
  const source = await readBoundedUtf8File(target, existing, maxBytes, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON: ${target}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain a JSON object: ${target}`);
  }
  return parsed;
}

function managedSkillMapFromEntries(
  entries: readonly unknown[],
  maxEntries: number,
  target: string,
): ReadonlyMap<string, string> {
  if (entries.length > maxEntries) {
    throw new Error(`Managed plugin state has too many managed skill entries: ${target}`);
  }
  const managed = new Map<string, string>();
  const portablePaths = new Map<string, string>();
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ['path', 'sha256'])
      || typeof entry.path !== 'string'
      || !isManagedSkillPath(entry.path)
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || managed.has(entry.path)
    ) {
      throw new Error(`Managed plugin manifest contains an invalid skill entry: ${target}`);
    }
    registerPortableGeneratedPath(entry.path, portablePaths);
    managed.set(entry.path, entry.sha256);
  }
  return managed;
}

function managedSkillEntries(
  managed: ReadonlyMap<string, string>,
): readonly ManagedSkillFile[] {
  return [...managed]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([managedPath, sha256]) => ({ path: managedPath, sha256 }));
}

function managedSkillOperationsFromEntries(
  entries: readonly unknown[],
  target: string,
): readonly ManagedSkillOperation[] {
  if (entries.length > MANAGED_MANIFEST_MAX_ENTRIES) {
    throw new Error(`Managed plugin transaction has too many operations: ${target}`);
  }
  const operations: ManagedSkillOperation[] = [];
  const paths = new Set<string>();
  const portablePaths = new Set<string>();
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ['path', 'present'])
      || typeof entry.path !== 'string'
      || !isManagedSkillPath(entry.path)
      || typeof entry.present !== 'boolean'
      || paths.has(entry.path)
      || portablePaths.has(portablePathKey(entry.path))
    ) {
      throw new Error(`Managed plugin transaction contains an invalid operation: ${target}`);
    }
    paths.add(entry.path);
    portablePaths.add(portablePathKey(entry.path));
    operations.push({ path: entry.path, present: entry.present });
  }
  return operations;
}

function assertManagedSkillTransactionOperations(
  transaction: ManagedSkillTransaction,
  target = MANAGED_SKILLS_TRANSACTION,
): void {
  const retained = [...transaction.previous.keys()]
    .filter((relativePath) => transaction.current.has(relativePath))
    .sort((left, right) => left.localeCompare(right));
  const stale = [...transaction.previous.keys()]
    .filter((relativePath) => !transaction.current.has(relativePath))
    .sort(compareManagedPathsDeepestFirst);
  if (
    transaction.retained.length !== retained.length
    || transaction.stale.length !== stale.length
    || transaction.retained.some((operation, index) => operation.path !== retained[index])
    || transaction.stale.some((operation, index) => operation.path !== stale[index])
  ) {
    throw new Error(`Managed plugin transaction operations do not match its generations: ${target}`);
  }
}

function pluginGeneration(files: Readonly<Record<string, string>>): string {
  return contentDigest(JSON.stringify(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content]) => ({
        path: relativePath,
        sha256: contentDigest(content),
      })),
  ));
}

function managedSkillMapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [relativePath, digest] of left) {
    if (right.get(relativePath) !== digest) return false;
  }
  return true;
}

async function createManagedSkillTransaction(
  root: string,
  files: Readonly<Record<string, string>>,
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  previousManifest: boolean,
): Promise<ManagedSkillTransaction> {
  assertCrossGenerationPathCompatibility(previous, current);
  const retained: ManagedSkillOperation[] = [];
  const stale: ManagedSkillOperation[] = [];
  for (const [relativePath, expectedDigest] of [...previous]
    .sort(([left], [right]) => left.localeCompare(right))
  ) {
    const state = await inspectManagedPath(root, relativePath);
    if (state.kind === 'file' && state.sha256 !== expectedDigest) {
      const action = current.has(relativePath) ? 'overwrite' : 'reconcile';
      throw new Error(
        `Cannot safely ${action} modified managed plugin skill: ${relativePath}`,
      );
    }
    if (state.kind === 'directory' || state.kind === 'blocked') {
      throw new Error(`Cannot safely reconcile managed plugin path shape: ${relativePath}`);
    }
    const operation = { path: relativePath, present: state.kind === 'file' };
    if (current.has(relativePath)) retained.push(operation);
    else stale.push(operation);
  }
  stale.sort((left, right) => compareManagedPathsDeepestFirst(left.path, right.path));
  const transaction: ManagedSkillTransaction = {
    id: randomUUID(),
    generation: pluginGeneration(files),
    previousManifest,
    previous,
    current,
    retained,
    stale,
  };
  assertManagedSkillTransactionOperations(transaction);
  return transaction;
}

async function validateManagedSkillTransactionManifest(
  root: string,
  transaction: ManagedSkillTransaction,
): Promise<void> {
  const manifest = await readManagedSkillFiles(root);
  if (!manifest) return;
  if (managedSkillMapsEqual(manifest, transaction.current)) return;
  if (
    transaction.previousManifest
    && managedSkillMapsEqual(manifest, transaction.previous)
  ) {
    return;
  }
  throw new Error(
    'Managed plugin manifest changed during an incomplete plugin transaction.',
  );
}

async function isManagedSkillTransactionCommitted(
  root: string,
  files: Readonly<Record<string, string>>,
  transaction: ManagedSkillTransaction,
): Promise<boolean> {
  const manifest = await readManagedSkillFiles(root);
  if (!manifest || !managedSkillMapsEqual(manifest, transaction.current)) return false;
  for (const [relativePath, content] of Object.entries(files)) {
    const state = await inspectGeneratedPluginPath(root, relativePath, content);
    if (state.kind !== 'file' || state.sha256 !== contentDigest(content)) return false;
  }
  return true;
}

async function assertNoManagedSkillTransactionData(root: string): Promise<void> {
  const target = path.resolve(root, MANAGED_SKILLS_TRANSACTION_DATA);
  assertContained(root, target);
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    throw new Error(`Orphaned managed plugin transaction data must be removed: ${target}`);
  }
}

async function readManifestlessManagedSkillFiles(
  root: string,
  current: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
  const candidates = new Map<string, Set<string>>();
  for (const files of [
    projectLegacyPackageSkills(CODEX_PACKAGE_DECLARATIONS),
    projectPackageSkills(CODEX_PACKAGE_DECLARATIONS),
  ]) {
    for (const [relativePath, digest] of managedSkillFiles(files)) {
      addKnownDigest(candidates, relativePath, digest);
    }
  }
  for (const [relativePath, digest] of current) {
    addKnownDigest(candidates, relativePath, digest);
  }
  const attributed = new Map<string, string>();
  const sortedCandidates = [...candidates].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [relativePath, knownDigests] of sortedCandidates) {
    const digest = await readManagedSkillDigest(root, relativePath);
    if (!digest) continue;
    if (!knownDigests.has(digest)) {
      throw new Error(
        `Cannot safely reconcile manifest-less plugin skill ${relativePath}; `
        + 'its bytes do not match a known generated digest.',
      );
    }
    attributed.set(relativePath, digest);
  }
  return attributed;
}

async function reconcileManagedSkillTransaction(
  root: string,
  files: Readonly<Record<string, string>>,
  transaction: ManagedSkillTransaction,
): Promise<void> {
  await validateManagedSkillTransaction(root, transaction, true);
  const added = [...transaction.current.keys()]
    .filter((relativePath) => !transaction.previous.has(relativePath))
    .sort();

  let retainedWritten = 0;
  for (const operation of transaction.retained) {
    await writeManagedSkillFile(root, files, transaction, operation.path);
    retainedWritten += 1;
    if (retainedWritten === 1) injectPluginInstallFault('after-first-retained-write');
  }
  injectPluginInstallFault('after-retained-write');

  for (const operation of transaction.stale) {
    await quarantineManagedSkillFile(root, transaction, operation);
  }
  injectPluginInstallFault('after-stale-quarantine');

  for (const relativePath of added) {
    await writeManagedSkillFile(root, files, transaction, relativePath);
  }

  const unmanagedFiles = Object.fromEntries(
    Object.entries(files).filter(([relativePath]) => !isManagedSkillPath(relativePath)),
  );
  await writeGeneratedPluginFiles(root, unmanagedFiles, true);
  await writeManagedSkillManifest(root, transaction.current, true);
  await removeManagedSkillTransaction(root, transaction);
}

async function validateManagedSkillTransaction(
  root: string,
  transaction: ManagedSkillTransaction,
  recovering: boolean,
): Promise<void> {
  assertCrossGenerationPathCompatibility(transaction.previous, transaction.current);
  assertManagedSkillTransactionOperations(transaction);
  await validateManagedSkillTransactionData(root, transaction);
  const states = new Map<string, ManagedPathState>();
  const inspect = async (relativePath: string): Promise<ManagedPathState> => {
    const existing = states.get(relativePath);
    if (existing) return existing;
    const state = await inspectManagedPath(root, relativePath);
    states.set(relativePath, state);
    return state;
  };

  for (const operation of transaction.retained) {
    const previousDigest = transaction.previous.get(operation.path)!;
    const currentDigest = transaction.current.get(operation.path)!;
    const state = await inspect(operation.path);
    if (state.kind === 'missing') {
      if (!recovering && operation.present) {
        throw new Error(`Managed plugin skill changed during reconciliation: ${operation.path}`);
      }
      continue;
    }
    if (state.kind === 'file') {
      if (
        state.sha256 !== previousDigest
        && !(recovering && state.sha256 === currentDigest)
      ) {
        throw new Error(`Cannot safely overwrite modified managed plugin skill: ${operation.path}`);
      }
      continue;
    }
    throw new Error(`Cannot safely reconcile managed plugin path shape: ${operation.path}`);
  }

  for (const operation of transaction.stale) {
    const previousDigest = transaction.previous.get(operation.path)!;
    const state = await inspect(operation.path);
    const quarantine = await inspectManagedSkillQuarantinePath(
      root,
      transaction,
      operation.path,
    );
    if (quarantine.kind === 'file') {
      if (
        !recovering
        || !operation.present
        || quarantine.sha256 !== previousDigest
      ) {
        throw new Error(`Managed plugin quarantine is invalid: ${operation.path}`);
      }
      if (state.kind === 'file' && state.sha256 !== previousDigest) {
        throw new Error(`Cannot safely reconcile modified managed plugin skill: ${operation.path}`);
      }
      if (
        (state.kind === 'directory' || state.kind === 'blocked')
        && !isManagedCurrentShape(transaction.current, operation.path, state)
      ) {
        throw new Error(`Cannot safely reconcile managed plugin path shape: ${operation.path}`);
      }
      continue;
    }
    if (quarantine.kind !== 'missing') {
      throw new Error(`Managed plugin quarantine has an unsafe shape: ${operation.path}`);
    }
    if (!operation.present) {
      if (state.kind === 'missing') continue;
      if (recovering && isManagedCurrentShape(transaction.current, operation.path, state)) {
        continue;
      }
      throw new Error(`Managed plugin skill changed during reconciliation: ${operation.path}`);
    }
    if (state.kind === 'file') {
      if (state.sha256 !== previousDigest) {
        throw new Error(`Cannot safely reconcile modified managed plugin skill: ${operation.path}`);
      }
      continue;
    }
    throw new Error(`Managed plugin quarantine is missing owned bytes: ${operation.path}`);
  }

  for (const [relativePath, currentDigest] of transaction.current) {
    const state = await inspect(relativePath);
    const previousDigest = transaction.previous.get(relativePath);
    if (state.kind === 'missing') continue;
    if (state.kind === 'file') {
      const ownedBeforeTransaction =
        previousDigest !== undefined && state.sha256 === previousDigest;
      const ownedDuringRecovery = recovering && state.sha256 === currentDigest;
      if (!ownedBeforeTransaction && !ownedDuringRecovery) {
        throw new Error(`Cannot safely overwrite unowned plugin skill: ${relativePath}`);
      }
      continue;
    }
    if (state.kind === 'directory' && hasManagedDescendant(transaction.previous, relativePath)) {
      await validateManagedDirectoryReplacement(root, relativePath, transaction.previous);
      continue;
    }
    if (
      state.kind === 'blocked'
      && hasManagedAncestor(transaction.previous, relativePath, state.blocker)
    ) {
      continue;
    }
    throw new Error(`Cannot safely create managed plugin path: ${relativePath}`);
  }
}

async function validateManagedSkillTransactionData(
  root: string,
  transaction: ManagedSkillTransaction,
): Promise<void> {
  const dataRoot = path.resolve(root, MANAGED_SKILLS_TRANSACTION_DATA);
  assertContained(root, dataRoot);
  const dataState = await fs.lstat(dataRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!dataState) return;
  if (dataState.isSymbolicLink() || !dataState.isDirectory()) {
    throw new Error(`Managed plugin transaction data path is unsafe: ${dataRoot}`);
  }
  const expectedFiles = new Set(
    transaction.stale
      .filter((operation) => operation.present)
      .map((operation) => operation.path),
  );
  let visited = 0;
  for (const entry of await fs.readdir(dataRoot, { withFileTypes: true })) {
    visited += 1;
    if (visited > MANAGED_TRANSACTION_SCAN_MAX_ENTRIES) {
      throw new Error(`Managed plugin transaction data exceeds its scan limit: ${dataRoot}`);
    }
    if (entry.name !== transaction.id) {
      throw new Error(`Managed plugin transaction data contains an unexpected entry: ${entry.name}`);
    }
    const transactionRoot = path.join(dataRoot, entry.name);
    const stat = await fs.lstat(transactionRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Managed plugin transaction data path is unsafe: ${transactionRoot}`);
    }
    await visit(transactionRoot, '');
  }

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MANAGED_TRANSACTION_SCAN_MAX_ENTRIES) {
        throw new Error(`Managed plugin transaction data exceeds its scan limit: ${dataRoot}`);
      }
      const target = path.join(directory, entry.name);
      const relativeTarget = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed plugin transaction data contains a symbolic link: ${relativeTarget}`);
      }
      if (stat.isDirectory()) {
        if (![...expectedFiles].some((expected) =>
          expected.startsWith(`${relativeTarget}/`))) {
          throw new Error(
            `Managed plugin transaction data contains an unexpected entry: ${relativeTarget}`,
          );
        }
        await visit(target, relativeTarget);
        continue;
      }
      if (!stat.isFile() || !expectedFiles.has(relativeTarget)) {
        throw new Error(
          `Managed plugin transaction data contains an unexpected entry: ${relativeTarget}`,
        );
      }
    }
  }
}

function isManagedCurrentShape(
  current: ReadonlyMap<string, string>,
  relativePath: string,
  state: ManagedPathState,
): boolean {
  return (
    (state.kind === 'directory' && hasManagedDescendant(current, relativePath))
    || (
      state.kind === 'blocked'
      && hasManagedAncestor(current, relativePath, state.blocker)
    )
  );
}

function assertCrossGenerationPathCompatibility(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): void {
  const previousByPortablePath = new Map(
    [...previous.keys()].map((relativePath) => [portablePathKey(relativePath), relativePath]),
  );
  for (const relativePath of current.keys()) {
    const previousPath = previousByPortablePath.get(portablePathKey(relativePath));
    if (previousPath && previousPath !== relativePath) {
      throw new Error(
        `Cannot safely reconcile case-only managed plugin path change: `
        + `${previousPath} -> ${relativePath}`,
      );
    }
  }
}

async function writeManagedSkillFile(
  root: string,
  files: Readonly<Record<string, string>>,
  transaction: ManagedSkillTransaction,
  relativePath: string,
): Promise<void> {
  const content = files[relativePath];
  const currentDigest = transaction.current.get(relativePath);
  if (content === undefined || currentDigest === undefined || contentDigest(content) !== currentDigest) {
    throw new Error(`Generated plugin content is missing for managed skill: ${relativePath}`);
  }
  const state = await inspectManagedPath(root, relativePath);
  const previousDigest = transaction.previous.get(relativePath);
  if (
    state.kind === 'file'
    && state.sha256 !== currentDigest
    && state.sha256 !== previousDigest
  ) {
    throw new Error(`Managed plugin skill changed during reconciliation: ${relativePath}`);
  }
  if (state.kind === 'directory' || state.kind === 'blocked') {
    throw new Error(`Managed plugin path shape was not cleared before writing: ${relativePath}`);
  }
  const target = managedSkillTarget(root, relativePath);
  await ensureRealDirectoryChain(root, path.dirname(target));
  await atomicWrite(target, content, root, true);
}

async function quarantineManagedSkillFile(
  root: string,
  transaction: ManagedSkillTransaction,
  operation: ManagedSkillOperation,
): Promise<void> {
  const previousDigest = transaction.previous.get(operation.path)!;
  const source = managedSkillTarget(root, operation.path);
  const quarantine = managedSkillQuarantineTarget(root, transaction, operation.path);
  let sourceState = await inspectManagedPath(root, operation.path);
  let quarantineState = await inspectManagedSkillQuarantinePath(
    root,
    transaction,
    operation.path,
  );
  if (!operation.present) {
    await pruneEmptySkillDirectories(root, path.dirname(source));
    return;
  }
  if (quarantineState.kind === 'file') {
    if (quarantineState.sha256 !== previousDigest) {
      throw new Error(`Managed plugin quarantine changed during reconciliation: ${operation.path}`);
    }
    if (sourceState.kind === 'file') {
      if (sourceState.sha256 !== previousDigest) {
        throw new Error(`Managed plugin skill changed during reconciliation: ${operation.path}`);
      }
      await fs.unlink(source);
      sourceState = { kind: 'missing' };
    }
  } else {
    if (quarantineState.kind !== 'missing' || sourceState.kind !== 'file') {
      throw new Error(`Managed plugin quarantine state changed: ${operation.path}`);
    }
    if (sourceState.sha256 !== previousDigest) {
      throw new Error(`Managed plugin skill changed during reconciliation: ${operation.path}`);
    }
    await ensureRealDirectoryChain(root, path.dirname(quarantine));
    await fs.link(source, quarantine);
    quarantineState = await inspectManagedSkillQuarantinePath(
      root,
      transaction,
      operation.path,
    );
    if (quarantineState.kind !== 'file' || quarantineState.sha256 !== previousDigest) {
      throw new Error(`Managed plugin quarantine write was not durable: ${operation.path}`);
    }
    await fs.unlink(source);
  }
  await pruneEmptySkillDirectories(root, path.dirname(source));
}

async function removeManagedSkillTransaction(
  root: string,
  transaction: ManagedSkillTransaction,
): Promise<void> {
  await removeManagedSkillQuarantine(root, transaction);
  const target = path.resolve(root, MANAGED_SKILLS_TRANSACTION);
  assertContained(root, target);
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!existing) return;
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error(`Refusing to remove unsafe managed plugin transaction: ${target}`);
  }
  await fs.unlink(target);
}

async function removeManagedSkillQuarantine(
  root: string,
  transaction: ManagedSkillTransaction,
): Promise<void> {
  const transactionRoot = managedSkillQuarantineRoot(root, transaction);
  for (const operation of transaction.stale) {
    if (!operation.present) continue;
    const target = managedSkillQuarantineTarget(root, transaction, operation.path);
    const state = await inspectManagedSkillQuarantinePath(root, transaction, operation.path);
    if (state.kind === 'file') {
      const expectedDigest = transaction.previous.get(operation.path)!;
      if (state.sha256 !== expectedDigest) {
        throw new Error(`Refusing to remove changed managed plugin quarantine: ${operation.path}`);
      }
      await fs.unlink(target);
    } else if (state.kind !== 'missing') {
      throw new Error(`Refusing to remove unsafe managed plugin quarantine: ${operation.path}`);
    }
    await pruneEmptyManagedTransactionDirectories(
      transactionRoot,
      path.dirname(target),
    );
  }
  await removeEmptyManagedTransactionDirectory(transactionRoot);
  await removeEmptyManagedTransactionDirectory(
    path.resolve(root, MANAGED_SKILLS_TRANSACTION_DATA),
  );
}

async function pruneEmptyManagedTransactionDirectories(
  transactionRoot: string,
  directory: string,
): Promise<void> {
  let current = directory;
  while (current !== transactionRoot) {
    assertContained(transactionRoot, current);
    const existing = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!existing) {
      current = path.dirname(current);
      continue;
    }
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Managed plugin quarantine path is unsafe: ${current}`);
    }
    try {
      await fs.rmdir(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        current = path.dirname(current);
        continue;
      }
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      throw error;
    }
    current = path.dirname(current);
  }
}

async function removeEmptyManagedTransactionDirectory(directory: string): Promise<void> {
  const existing = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!existing) return;
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error(`Managed plugin transaction data path is unsafe: ${directory}`);
  }
  try {
    await fs.rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw new Error(`Managed plugin transaction data contains unexpected entries: ${directory}`);
    }
    throw error;
  }
}

function managedSkillQuarantineRoot(
  root: string,
  transaction: ManagedSkillTransaction,
): string {
  const target = path.resolve(root, MANAGED_SKILLS_TRANSACTION_DATA, transaction.id);
  assertContained(root, target);
  return target;
}

function managedSkillQuarantineTarget(
  root: string,
  transaction: ManagedSkillTransaction,
  relativePath: string,
): string {
  const target = path.resolve(
    managedSkillQuarantineRoot(root, transaction),
    ...relativePath.split('/'),
  );
  assertContained(managedSkillQuarantineRoot(root, transaction), target);
  return target;
}

async function inspectManagedPath(
  root: string,
  relativePath: string,
): Promise<ManagedPathState> {
  if (!isManagedSkillPath(relativePath)) {
    throw new Error(`Invalid managed plugin skill path: ${relativePath}`);
  }
  return inspectPluginPath(
    root,
    managedSkillTarget(root, relativePath),
    MANAGED_SKILL_MAX_BYTES,
    'Managed plugin path',
  );
}

async function inspectManagedSkillQuarantinePath(
  root: string,
  transaction: ManagedSkillTransaction,
  relativePath: string,
): Promise<ManagedPathState> {
  return inspectPluginPath(
    root,
    managedSkillQuarantineTarget(root, transaction, relativePath),
    MANAGED_SKILL_MAX_BYTES,
    'Managed plugin quarantine path',
  );
}

async function inspectGeneratedPluginPath(
  root: string,
  relativePath: string,
  expectedContent: string,
): Promise<ManagedPathState> {
  const target = path.resolve(root, ...relativePath.split('/'));
  assertContained(root, target);
  return inspectPluginPath(
    root,
    target,
    Math.max(Buffer.byteLength(expectedContent, 'utf8'), MANAGED_SKILL_MAX_BYTES),
    'Generated plugin path',
  );
}

async function inspectPluginPath(
  root: string,
  target: string,
  maxBytes: number,
  label: string,
): Promise<ManagedPathState> {
  assertContained(root, target);
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (!stat) return { kind: 'missing' };
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} is not a real directory or file: ${current}`);
    }
    const relativeCurrent = path.relative(root, current).replaceAll(path.sep, '/');
    if (index < parts.length - 1) {
      if (stat.isDirectory()) continue;
      if (stat.isFile()) return { kind: 'blocked', blocker: relativeCurrent };
      throw new Error(`${label} has an unsafe component: ${current}`);
    }
    if (stat.isDirectory()) return { kind: 'directory' };
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${current}`);
    const content = await readBoundedUtf8File(
      current,
      stat,
      maxBytes,
      label,
    );
    return { kind: 'file', sha256: contentDigest(content) };
  }
  return { kind: 'missing' };
}

async function validateManagedDirectoryReplacement(
  root: string,
  relativeDirectory: string,
  previous: ReadonlyMap<string, string>,
): Promise<void> {
  const expectedFiles = new Map(
    [...previous].filter(([relativePath]) => isManagedPathPrefix(relativeDirectory, relativePath)),
  );
  if (expectedFiles.size === 0) {
    throw new Error(`Managed plugin directory has no attributable files: ${relativeDirectory}`);
  }
  const directory = path.resolve(root, ...relativeDirectory.split('/'));
  assertContained(root, directory);
  let visited = 0;
  await visit(directory, relativeDirectory);

  async function visit(current: string, relativeCurrent: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MANAGED_DIRECTORY_SCAN_MAX_ENTRIES) {
        throw new Error(
          `Managed plugin directory exceeds the ${MANAGED_DIRECTORY_SCAN_MAX_ENTRIES}-entry scan limit: `
          + relativeDirectory,
        );
      }
      const target = path.join(current, entry.name);
      const relativeTarget = `${relativeCurrent}/${entry.name}`;
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed plugin directory contains a symbolic link: ${relativeTarget}`);
      }
      if (stat.isDirectory()) {
        if (![...expectedFiles.keys()].some((expected) =>
          isManagedPathPrefix(relativeTarget, expected))) {
          throw new Error(`Cannot replace managed directory containing user content: ${relativeTarget}`);
        }
        await visit(target, relativeTarget);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Managed plugin directory contains an unsafe entry: ${relativeTarget}`);
      }
      const expectedDigest = expectedFiles.get(relativeTarget);
      if (!expectedDigest) {
        throw new Error(`Cannot replace managed directory containing user content: ${relativeTarget}`);
      }
      const content = await readBoundedUtf8File(
        target,
        stat,
        MANAGED_SKILL_MAX_BYTES,
        'Managed plugin skill',
      );
      if (contentDigest(content) !== expectedDigest) {
        throw new Error(`Cannot replace modified managed plugin skill: ${relativeTarget}`);
      }
    }
  }
}

async function readManagedSkillDigest(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  const state = await inspectManagedPath(root, relativePath);
  if (state.kind === 'missing') return undefined;
  if (state.kind !== 'file') {
    throw new Error(`Refusing to reconcile non-file managed plugin path: ${relativePath}`);
  }
  return state.sha256;
}

function managedSkillTarget(root: string, relativePath: string): string {
  if (!isManagedSkillPath(relativePath)) {
    throw new Error(`Invalid managed plugin skill path: ${relativePath}`);
  }
  const target = path.resolve(root, ...relativePath.split('/'));
  assertContained(root, target);
  return target;
}

function addKnownDigest(
  candidates: Map<string, Set<string>>,
  relativePath: string,
  digest: string,
): void {
  const digests = candidates.get(relativePath) ?? new Set<string>();
  digests.add(digest);
  candidates.set(relativePath, digests);
}

function hasManagedDescendant(
  managed: ReadonlyMap<string, string>,
  relativePath: string,
): boolean {
  return [...managed.keys()].some((candidate) => isManagedPathPrefix(relativePath, candidate));
}

function hasManagedAncestor(
  managed: ReadonlyMap<string, string>,
  relativePath: string,
  blocker: string,
): boolean {
  return managed.has(blocker) && isManagedPathPrefix(blocker, relativePath);
}

function isManagedPathPrefix(parent: string, child: string): boolean {
  return portablePathKey(child).startsWith(`${portablePathKey(parent)}/`);
}

function compareManagedPathsDeepestFirst(left: string, right: string): number {
  return right.split('/').length - left.split('/').length || left.localeCompare(right);
}

function injectPluginInstallFault(
  point:
    | 'after-first-retained-write'
    | 'after-retained-write'
    | 'after-stale-quarantine',
): void {
  const configured = process.env[PLUGIN_INSTALL_TEST_FAULT_ENV];
  if (
    process.env.NODE_ENV === 'test'
    && (
      configured === point
      || (point === 'after-stale-quarantine' && configured === 'after-stale-removal')
    )
  ) {
    throw new Error(`Injected Codex plugin install fault: ${configured}`);
  }
}

async function assertRealDirectoryChain(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  assertContained(root, directory);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Managed plugin path is not a real directory: ${current}`);
    }
  }
}

async function pruneEmptySkillDirectories(root: string, directory: string): Promise<void> {
  const skillsRoot = path.resolve(root, 'skills');
  let current = directory;
  while (current !== skillsRoot) {
    assertContained(skillsRoot, current);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`Managed plugin path is not a real directory: ${current}`);
    }
    if (!stat.isDirectory()) return;
    try {
      await fs.rmdir(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return;
      throw error;
    }
    current = path.dirname(current);
  }
}

function isManagedSkillPath(relativePath: string): boolean {
  const parts = portablePathSegments(relativePath);
  if (!parts) return false;
  if (
    parts[0] !== 'skills'
    || parts.length < 3
  ) {
    return false;
  }
  return (
    (parts.length === 3 && parts[2] === 'SKILL.md')
    || (parts.length >= 4 && parts[2] === 'references')
  );
}

function assertPortableGeneratedPaths(relativePaths: readonly string[]): void {
  const registered = new Map<string, string>();
  for (const relativePath of [...relativePaths].sort()) {
    registerPortableGeneratedPath(relativePath, registered);
  }
}

function registerPortableGeneratedPath(
  relativePath: string,
  registered: Map<string, string>,
): void {
  if (!portablePathSegments(relativePath)) {
    throw new Error(`Generated plugin path is not portable: ${relativePath}`);
  }
  const key = portablePathKey(relativePath);
  const exact = registered.get(key);
  if (exact) {
    throw new Error(`Case-folded generated plugin path collision: ${exact} and ${relativePath}`);
  }
  for (const [existingKey, existingPath] of registered) {
    if (key.startsWith(`${existingKey}/`) || existingKey.startsWith(`${key}/`)) {
      throw new Error(
        `Generated plugin file/directory path collision: ${existingPath} and ${relativePath}`,
      );
    }
  }
  registered.set(key, relativePath);
}

function portablePathSegments(relativePath: string): readonly string[] | undefined {
  if (
    relativePath.length === 0
    || relativePath.length > GENERATED_PATH_MAX_LENGTH
    || relativePath.includes('\\')
    || relativePath.startsWith('/')
    || /[\0-\x1f\x7f]/.test(relativePath)
  ) {
    return undefined;
  }
  const parts = relativePath.split('/');
  if (parts.length > GENERATED_PATH_MAX_DEPTH) return undefined;
  for (const part of parts) {
    if (
      part.length === 0
      || part.length > GENERATED_PATH_SEGMENT_MAX_LENGTH
      || part === '.'
      || part === '..'
      || !PORTABLE_PATH_SEGMENT_PATTERN.test(part)
      || part.startsWith(' ')
      || part.endsWith(' ')
      || part.endsWith('.')
      || isWindowsReservedPathSegment(part)
    ) {
      return undefined;
    }
  }
  return parts;
}

function assertPortablePathSegment(segment: string, label: string): void {
  if (!portablePathSegments(segment)) {
    throw new Error(`${label} is not portable: ${segment}`);
  }
}

function portablePathKey(relativePath: string): string {
  return relativePath.toLowerCase();
}

function isWindowsReservedPathSegment(segment: string): boolean {
  const baseName = segment.split('.')[0]!.replace(/[ .]+$/g, '');
  return WINDOWS_RESERVED_PATH_SEGMENT.test(baseName);
}

async function readBoundedUtf8File(
  target: string,
  initialStat: Awaited<ReturnType<typeof fs.lstat>>,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (initialStat.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
  }
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${target}`);
    if (stat.size > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
    }
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function withTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectCodexHooks(
  runtimeLaunch?: CodexPluginRuntimeLaunch,
  declarations: readonly RuntimePackageDeclaration[] = CODEX_PACKAGE_DECLARATIONS,
): Readonly<Record<string, unknown>> {
  const hints = new Map(projectNativeCallbackHints().map((hint) => [hint.phase, hint]));
  const phases = new Set(declarations.flatMap((declaration) => declaration.lifecyclePhases ?? []));
  const hook = (phase: Parameters<typeof hints.get>[0], timeout: number) => {
    const hint = hints.get(phase);
    if (!hint) throw new Error(`Capability manifest has no callback hint for ${phase}.`);
    const command = runtimeLaunch
      ? `${quotePosix(runtimeLaunch.nodeExecutable)} ${quotePosix(runtimeLaunch.hookEntrypoint)}`
      : 'agent-runtime-codex-hook';
    const commandWindows = runtimeLaunch
      ? `${quoteWindows(runtimeLaunch.nodeExecutable)} ${quoteWindows(runtimeLaunch.hookEntrypoint)}`
      : 'agent-runtime-codex-hook';
    return {
      type: 'command',
      command: projectPosixHookEnvironment(command),
      commandWindows: projectWindowsHookEnvironment(commandWindows, runtimeLaunch),
      timeout,
      statusMessage: hint.purpose,
      ...(hint.injectsContext ? { additionalContextLimit: 8_000 } : {}),
    };
  };
  const hooks: Record<string, unknown> = {};
  if (phases.has('session.start')) {
    hooks.SessionStart = [{
      matcher: 'startup|resume|clear|compact',
      hooks: [hook('session.start', 15)],
    }];
  }
  if (phases.has('prompt.submit')) {
    hooks.UserPromptSubmit = [{ hooks: [hook('prompt.submit', 15)] }];
  }
  if (phases.has('tool.invoke')) {
    hooks.PreToolUse = [{
      matcher: '^mcp__marshal[-_]runtime__.*$',
      hooks: [hook('tool.invoke', 2)],
    }];
  }
  if (phases.has('tool.result')) {
    hooks.PostToolUse = [{ matcher: '.*', hooks: [hook('tool.result', 15)] }];
  }
  if (phases.has('assistant.complete')) {
    hooks.Stop = [{ hooks: [hook('assistant.complete', 15)] }];
  }
  if (phases.has('session.end')) {
    hooks.SessionEnd = [{ hooks: [hook('session.end', 5)] }];
  }
  if (phases.has('subagent.start')) {
    hooks.SubagentStart = [{ hooks: [hook('subagent.start', 15)] }];
  }
  if (phases.has('subagent.end')) {
    hooks.SubagentStop = [{ hooks: [hook('subagent.end', 15)] }];
  }
  return {
    description: `Automatic Marshal lifecycle integration from manifest ${MARSHAL_MANIFEST_VERSION}.`,
    hooks,
  };
}

function normalizeRuntimeLaunch(launch: CodexPluginRuntimeLaunch): CodexPluginRuntimeLaunch {
  for (const [name, value] of Object.entries(launch)) {
    if (value === undefined) continue;
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
    if (/[\0\r\n]/.test(value)) throw new Error(`${name} contains an unsafe control character.`);
  }
  return Object.freeze({
    nodeExecutable: path.resolve(launch.nodeExecutable),
    serverEntrypoint: path.resolve(launch.serverEntrypoint),
    hookEntrypoint: path.resolve(launch.hookEntrypoint),
    ...(launch.kernelModule ? { kernelModule: path.resolve(launch.kernelModule) } : {}),
  });
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function quoteWindows(value: string): string {
  if (!/[\s&()\[\]{}^=;!'+,`~]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function projectPosixHookEnvironment(
  command: string,
  environment?: Readonly<Record<string, string>>,
): string {
  const assignments = Object.entries(environment ?? {})
    .map(([name, value]) => `${name}=${quotePosix(value)}`);
  return assignments.length > 0 ? `${assignments.join(' ')} ${command}` : command;
}

function projectWindowsHookEnvironment(
  command: string,
  runtimeLaunch?: CodexPluginRuntimeLaunch,
  environment?: Readonly<Record<string, string>>,
): string {
  const assignments = Object.entries(environment ?? {})
    .map(([name, value]) => `$env:${name} = ${powerShellUtf8Expression(value)};`);
  if (assignments.length === 0) return command;
  const invocation = runtimeLaunch
    ? [
        `$hookExecutable = ${powerShellUtf8Expression(runtimeLaunch.nodeExecutable)};`,
        `$hookEntrypoint = ${powerShellUtf8Expression(runtimeLaunch.hookEntrypoint)};`,
        '& $hookExecutable $hookEntrypoint;',
      ].join(' ')
    : "& 'agent-runtime-codex-hook';";
  const script = `${assignments.join(' ')} ${invocation} exit $LASTEXITCODE;`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function powerShellUtf8Expression(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))`;
}

async function existingEntries(root: string): Promise<string[]> {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Plugin destination must be a real directory.');
    }
    return fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Plugin path is not a real directory: ${directory}`);
  }
}

async function atomicWrite(
  target: string,
  content: string,
  root: string,
  overwrite: boolean,
): Promise<void> {
  const temporary = path.join(path.dirname(target), `.marshal-plugin-${randomUUID()}.tmp`);
  assertContained(root, temporary);
  await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    if (!overwrite) {
      await fs.link(temporary, target);
      return;
    }
    const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error(`Refusing to overwrite unsafe plugin file: ${target}`);
    }
    await fs.rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await fs.unlink(target);
      await fs.rename(temporary, target);
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function assertSafeInstallRoot(root: string): void {
  if (path.parse(root).root === root) throw new Error('Plugin destination cannot be a filesystem root.');
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Generated plugin path escaped its destination.');
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
