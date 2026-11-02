import { builtinModules, createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { sameStableFileIdentity, type InvocationContext } from '@marshal/agent-runtime-core';
import type {
  UiAuthoringProfile,
  UiHostCapabilities,
} from './applicationTypes.js';
import {
  authoringProfileProvenance,
  UiAuthoringProfileRegistry,
} from './authoringProfiles.js';
import {
  BUNDLE_BUILD_OPTIONS,
  BUNDLE_OPTIONS_CONTENTS,
  BUNDLE_OPTIONS_INPUT_PATH,
} from './bundleOptions.js';
import { resolveWorkspaceSource } from './pathSafety.js';
import { digest } from './store.js';
import type {
  CompiledReactComponent,
  ReactUiBuildGraphAttestation,
  ReactUiBuildInputAttestation,
  ReactUiPackageIdentity,
  ReactUiPackageResolution,
  RegisteredReactComponent,
} from './types.js';

const MIME_TYPE = 'text/html;profile=mcp-app' as const;
const requireFromPackage = createRequire(import.meta.url);
const FRAMEWORK_IMPORTS = new Map(
  ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'].map((specifier) => [
    specifier,
    requireFromPackage.resolve(specifier),
  ]),
);
const FRAMEWORK_PACKAGE_ENTRIES = Object.freeze([
  requireFromPackage.resolve('react/package.json'),
  requireFromPackage.resolve('react-dom/package.json'),
]);
const DEFAULT_STYLE = `:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);-webkit-font-smoothing:antialiased}*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--color-text-primary,#171717)}#root{min-width:0}button,input,select,textarea{font:inherit}button{min-height:40px}`;
const STORAGE_BOOTSTRAP = `const __marshalReadMeta=name=>{try{const element=document.querySelector('meta[name="'+name+'"]');const encoded=element&&element.getAttribute('content')||'';if(!encoded)return {};const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));const parsed=JSON.parse(new TextDecoder().decode(bytes));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}}catch{return {}}};window.__MARSHAL_INITIAL_PROPS__=__marshalReadMeta('marshal-props');const __marshalLocalStorage=(()=>{let values=Object.assign(Object.create(null),__marshalReadMeta('marshal-storage'));const notify=(operation,key,value)=>parent.postMessage({jsonrpc:'2.0',method:'marshal/storage',params:{operation,key,value}},'*');const storage={get length(){return Object.keys(values).length},clear(){values=Object.create(null);notify('clear')},getItem(key){key=String(key);return Object.prototype.hasOwnProperty.call(values,key)?values[key]:null},key(index){return Object.keys(values)[Number(index)]??null},removeItem(key){key=String(key);delete values[key];notify('remove',key)},setItem(key,value){key=String(key);value=String(value);values[key]=value;notify('set',key,value)}};try{Object.defineProperty(window,'localStorage',{configurable:true,value:storage})}catch{}return storage})();`;
const RUNTIME_BOOTSTRAP = `const __marshalRuntime=__marshalReadMeta('marshal-runtime');window.__MARSHAL_APPLICATION__=__marshalRuntime.application;window.__MARSHAL_RENDER_ID__=__marshalRuntime.renderId;`;
const BLOCKED_SPECIFIERS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const GRAPH_SCHEMA_VERSION = 1 as const;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export interface ReactUiCompilerOptions {
  workspacePath: string;
  allowedPackages?: readonly string[];
  /** Adapter-supplied, versioned profiles. The portable standards profile is implicit. */
  authoringProfiles?: readonly UiAuthoringProfile[];
  preferredAuthoringProfile?: { id: string; version?: string };
  /** Truthful host capabilities supplied by the adapter, never authored input. */
  hostCapabilities?: UiHostCapabilities;
  /** Optional adapter resolver for packages bundled with the adapter installation. */
  packageImportResolver?: (specifier: string) => string | undefined;
  /** @deprecated Paths never confer package authority; retained for source compatibility. */
  trustedPackageRoots?: readonly string[];
  registeredComponents?: readonly RegisteredReactComponent[];
  maxSourceBytes?: number;
  maxBundleBytes?: number;
  /** Read-only build telemetry for benchmarks and host diagnostics; it grants no authority. */
  buildObserver?: (event: Readonly<{
    phase: 'resolve' | 'load';
    path: string;
    importer?: string;
  }>) => void;
}

export interface CompileWorkspaceComponentInput {
  entryPath: string;
  title: string;
  description?: string;
  authoringProfile?: { id: string; version?: string };
}

export class ReactUiCompiler {
  private readonly workspacePath: string;
  private readonly registry = new Map<string, RegisteredReactComponent>();
  readonly authoringProfiles: UiAuthoringProfileRegistry;

  constructor(private readonly options: ReactUiCompilerOptions) {
    this.workspacePath = resolve(options.workspacePath);
    this.authoringProfiles = new UiAuthoringProfileRegistry({
      profiles: options.authoringProfiles,
      preferred: options.preferredAuthoringProfile,
    });
    for (const component of options.registeredComponents ?? []) {
      if (this.registry.has(component.id)) {
        throw new Error(`Duplicate registered UI component: ${component.id}`);
      }
      if (!DIGEST_PATTERN.test(component.audit.sourceDigest)) {
        throw new Error(`Registered UI component ${component.id} has an invalid source digest`);
      }
      const graph = immutableGraph(component.audit.graph);
      this.registry.set(component.id, Object.freeze({
        ...component,
        allowedPackages: component.allowedPackages
          ? Object.freeze([...component.allowedPackages])
          : undefined,
        authoringProfile: component.authoringProfile
          ? Object.freeze({ ...component.authoringProfile })
          : undefined,
        audit: Object.freeze({ ...component.audit, graph }),
      }));
    }
  }

  async compileWorkspace(
    input: CompileWorkspaceComponentInput,
    context: InvocationContext,
  ): Promise<Omit<CompiledReactComponent, 'scopeKey'>> {
    void context;
    const source = await resolveWorkspaceSource(this.workspacePath, input.entryPath);
    const profileSelection = this.selectAuthoringProfile(input.authoringProfile);
    return this.compile({
      entryPath: source.relativePath,
      title: boundedText(input.title, 'title', 256),
      description: optionalText(input.description, 'description', 2_000),
      sourceKind: 'workspace_file',
      allowedPackages: mergePackages(
        this.options.allowedPackages,
        profileSelection.profile.packageImports,
      ),
      allowedPackageVersions: profileSelection.profile.packageVersions,
      authoringProfile: authoringProfileProvenance(profileSelection),
    });
  }

  async compileRegistered(
    componentId: string,
    context: InvocationContext,
  ): Promise<Omit<CompiledReactComponent, 'scopeKey'>> {
    void context;
    const registered = this.registry.get(componentId);
    if (!registered) throw new Error(`Registered UI component ${componentId} was not found`);
    const profileSelection = this.selectAuthoringProfile(registered.authoringProfile);
    if (registered.authoringProfile && profileSelection.status !== 'selected') {
      throw new Error(
        `Registered UI component ${componentId} requires unavailable authoring profile ${registered.authoringProfile.id}`,
      );
    }
    return this.compile({
      entryPath: registered.entryPath,
      title: boundedText(registered.title, 'registered title', 256),
      description: optionalText(registered.description, 'registered description', 2_000),
      sourceKind: 'registered_component',
      allowedPackages: mergePackages(
        registered.allowedPackages,
        profileSelection.profile.packageImports,
      ),
      allowedPackageVersions: profileSelection.profile.packageVersions,
      authoringProfile: authoringProfileProvenance(profileSelection),
      registeredComponent: {
        id: registered.id,
        version: registered.version,
        reviewedBy: registered.audit.reviewedBy,
        graphDigest: graphDigest(registered.audit.graph),
      },
    }, registered.audit);
  }

  /**
   * Build-time helper for a host reviewer to freeze the complete graph that a
   * registered component will later be allowed to compile. Calling this method
   * does not register or lower the risk of a component by itself.
   */
  async snapshotRegisteredGraph(input: {
    entryPath: string;
    allowedPackages?: readonly string[];
    authoringProfile?: { id: string; version?: string };
  }): Promise<Pick<RegisteredReactComponent['audit'], 'sourceDigest' | 'graph'>> {
    const profileSelection = this.selectAuthoringProfile(input.authoringProfile);
    if (input.authoringProfile && profileSelection.status !== 'selected') {
      throw new Error(`Registered UI audit requires available authoring profile ${input.authoringProfile.id}`);
    }
    const snapshot = await this.buildSnapshot({
      entryPath: input.entryPath,
      allowedPackages: mergePackages(
        input.allowedPackages,
        profileSelection.profile.packageImports,
      ),
      allowedPackageVersions: profileSelection.profile.packageVersions,
    });
    return { sourceDigest: snapshot.sourceDigest, graph: snapshot.graph };
  }

  listRegistered(): Array<Omit<RegisteredReactComponent, 'entryPath' | 'audit'> & {
    reviewedBy: string;
    reviewedAt: string;
  }> {
    return [...this.registry.values()].map((component) => ({
      id: component.id,
      version: component.version,
      title: component.title,
      description: component.description,
      allowedPackages: component.allowedPackages,
      authoringProfile: component.authoringProfile,
      reviewedBy: component.audit.reviewedBy,
      reviewedAt: component.audit.reviewedAt,
    }));
  }

  listAuthoringProfiles(): readonly UiAuthoringProfile[] {
    return this.authoringProfiles.list();
  }

  selectAuthoringProfile(requested?: { id: string; version?: string }) {
    return this.authoringProfiles.select(requested, this.options.hostCapabilities ?? {});
  }

  /**
   * Re-attest every compiler-selected source/package input plus the workspace
   * configuration search path. Any ambiguity is drift and triggers a guarded
   * rebuild; a failed rebuild never replaces the last-good component.
   */
  async isWorkspaceComponentCurrent(component: CompiledReactComponent): Promise<boolean> {
    if (component.sourceKind !== 'workspace_file' || !component.buildGraph) return false;
    try {
      const source = await resolveWorkspaceSource(this.workspacePath, component.sourcePath);
      const selection = this.selectAuthoringProfile(component.authoringProfile);
      const authority = await PackageImportAuthority.create({
        workspacePath: this.workspacePath,
        entryPath: source.absolutePath,
        allowedPackages: mergePackages(this.options.allowedPackages, selection.profile.packageImports),
        allowedPackageVersions: selection.profile.packageVersions,
        packageImportResolver: this.options.packageImportResolver,
      });
      const graph = canonicalGraph(component.buildGraph);
      if (!graph.inputs.some((input) => input.path === `__marshal__/${BUNDLE_OPTIONS_INPUT_PATH}`)) return false;
      const expectedWorkspace = new Set(
        graph.inputs.filter((input) => input.kind === 'workspace').map((input) => input.path),
      );
      for (const configPath of await relevantWorkspaceConfigPaths(this.workspacePath, source.absolutePath)) {
        const relativePath = canonicalRelativePath(await realpath(this.workspacePath), configPath);
        if (!expectedWorkspace.has(relativePath)) return false;
      }
      for (const input of graph.inputs) {
        const generated = runtimeInputContents(input.path);
        if (generated !== undefined) {
          if (input.kind !== 'package' || digest(generated) !== input.digest) return false;
          continue;
        }
        const path = input.kind === 'workspace'
          ? resolve(await realpath(this.workspacePath), input.path)
          : await authority.resolveAttestedPackageInput(input);
        const canonicalPath = await realpath(path);
        if (input.kind === 'workspace') await authority.assertLoadAllowed(path, canonicalPath);
        if (digest(await readStableFile(canonicalPath)) !== input.digest) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async compile(input: {
    entryPath: string;
    title: string;
    description?: string;
    sourceKind: CompiledReactComponent['sourceKind'];
    allowedPackages?: readonly string[];
    allowedPackageVersions?: Readonly<Record<string, string>>;
    authoringProfile: NonNullable<CompiledReactComponent['authoringProfile']>;
    registeredComponent?: CompiledReactComponent['registeredComponent'];
  }, expectedAudit?: RegisteredReactComponent['audit']): Promise<Omit<CompiledReactComponent, 'scopeKey'>> {
    const source = await resolveWorkspaceSource(this.workspacePath, input.entryPath);
    const snapshot = await this.buildSnapshot({
      entryPath: source.relativePath,
      allowedPackages: input.allowedPackages,
      allowedPackageVersions: input.allowedPackageVersions,
    });
    const { result, sourceDigest, graph } = snapshot;
    if (expectedAudit) {
      if (sourceDigest !== expectedAudit.sourceDigest) {
        throw new Error(
          `Registered UI component ${input.registeredComponent?.id ?? source.relativePath} no longer matches its audited source digest`,
        );
      }
      assertBuildGraphMatches(expectedAudit.graph, graph, input.registeredComponent?.id ?? source.relativePath);
    }
    const outputFiles = result.outputFiles ?? [];
    const javascript = outputFiles.find((file) => file.path.endsWith('.js'))?.text;
    const componentCss = outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
    if (!javascript) throw new Error('React UI compilation produced no JavaScript bundle');
    const maxBundleBytes = this.options.maxBundleBytes ?? 2_000_000;
    if (Buffer.byteLength(javascript) + Buffer.byteLength(componentCss) > maxBundleBytes) {
      throw new Error(`React UI bundle exceeds ${maxBundleBytes} bytes`);
    }
    const inputs = graph.inputs
      .filter((entry) => entry.kind === 'workspace')
      .map((entry) => entry.path)
      .sort();
    const embeddedScript = javascript.replaceAll('</script', '<\\/script');
    const embeddedStyle = `${DEFAULT_STYLE}\n${componentCss}`.replaceAll('</style', '<\\/style');
    const bundleDigest = digest(`${embeddedScript}\0${embeddedStyle}`);
    const html = renderHtml(input.title, embeddedScript, embeddedStyle);
    const htmlDigest = digest(html);
    const id = digest(
      JSON.stringify({
        protocol: 2,
        sourceKind: input.sourceKind,
        sourcePath: source.relativePath,
        sourceDigest,
        bundleDigest,
        htmlDigest,
        title: input.title,
        description: input.description ?? '',
        registeredComponent: input.registeredComponent ?? null,
        authoringProfile: input.authoringProfile,
        inputs,
        buildGraph: canonicalGraph(graph),
      }),
    );
    const resourceUri = `ui://marshal-react/${id}/index.html`;
    return {
      id,
      title: input.title,
      description: input.description,
      sourceKind: input.sourceKind,
      sourcePath: source.relativePath,
      sourceDigest,
      bundleDigest,
      htmlDigest,
      createdAt: new Date().toISOString(),
      resourceUri,
      html,
      inputs,
      buildGraph: canonicalGraph(graph),
      authoringProfile: input.authoringProfile,
      registeredComponent: input.registeredComponent,
    };
  }

  private async buildSnapshot(input: {
    entryPath: string;
    allowedPackages?: readonly string[];
    allowedPackageVersions?: Readonly<Record<string, string>>;
  }): Promise<{
    result: Awaited<ReturnType<typeof build>>;
    sourceDigest: string;
    graph: ReactUiBuildGraphAttestation;
  }> {
    const source = await resolveWorkspaceSource(this.workspacePath, input.entryPath);
    const authority = await PackageImportAuthority.create({
      workspacePath: this.workspacePath,
      entryPath: source.absolutePath,
      allowedPackages: input.allowedPackages,
      allowedPackageVersions: input.allowedPackageVersions,
      packageImportResolver: this.options.packageImportResolver,
    });
    const collector = await BuildSnapshotCollector.create({
      workspacePath: this.workspacePath,
      entryPath: source.absolutePath,
      authority,
      buildObserver: this.options.buildObserver,
    });
    await collector.captureWorkspaceConfigs();
    const result = await build({
      absWorkingDir: this.workspacePath,
      stdin: {
        contents: bootstrapSource(),
        resolveDir: this.workspacePath,
        sourcefile: 'marshal-react-ui-entry.tsx',
        loader: 'tsx',
      },
      outfile: 'marshal-react-ui.js',
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'iife',
      banner: { js: `${STORAGE_BOOTSTRAP}\n${RUNTIME_BOOTSTRAP}` },
      define: { localStorage: '__marshalLocalStorage', ...BUNDLE_BUILD_OPTIONS.define },
      minify: BUNDLE_BUILD_OPTIONS.minify,
      target: ['es2020'],
      jsx: 'automatic',
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'silent',
      loader: {
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.jpeg': 'dataurl',
        '.gif': 'dataurl',
        '.svg': 'dataurl',
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
      },
      plugins: [
        componentResolutionPlugin(
          source.absolutePath,
          authority,
          this.options.buildObserver,
        ),
        collector.plugin(),
      ],
    });
    const graph = await collector.attestation();
    const sourceDigest = collector.digestFor(source.absolutePath);
    const limit = this.options.maxSourceBytes ?? 500_000;
    if (collector.byteLengthFor(source.absolutePath) > limit) {
      throw new Error(`UI source exceeds ${limit} bytes`);
    }
    return { result, sourceDigest, graph };
  }
}

interface CapturedBuildInput {
  canonicalPath: string;
  bytes: Uint8Array;
  digest: string;
}

interface AuthorizedPackage {
  root: string;
  identity: ReactUiPackageIdentity;
  dependencies: ReadonlySet<string>;
}

class PackageImportAuthority {
  private readonly authorizedPackages = new Map<string, AuthorizedPackage>();
  private readonly packageCache = new Map<string, Promise<AuthorizedPackage>>();
  private readonly packageResolutions = new Map<string, ReactUiPackageResolution>();

  private constructor(
    private readonly workspaceRoot: string,
    private readonly entryPath: string,
    private readonly allowedPackages: ReadonlySet<string>,
    private readonly allowedPackageVersions: Readonly<Record<string, string>>,
    private readonly packageImportResolver: ReactUiCompilerOptions['packageImportResolver'],
  ) {}

  static async create(options: {
    workspacePath: string;
    entryPath: string;
    allowedPackages?: readonly string[];
    allowedPackageVersions?: Readonly<Record<string, string>>;
    packageImportResolver: ReactUiCompilerOptions['packageImportResolver'];
  }): Promise<PackageImportAuthority> {
    const allowedPackages = new Set((options.allowedPackages ?? []).map(packageNameOf));
    if (allowedPackages.has('*')) {
      throw new Error('Wildcard UI package authority is unavailable; packages must be named explicitly');
    }
    const versions = Object.fromEntries(
      Object.entries(options.allowedPackageVersions ?? {}).map(([name, version]) => [packageNameOf(name), version]),
    );
    const authority = new PackageImportAuthority(
      await realpath(resolve(options.workspacePath)),
      await realpath(options.entryPath),
      allowedPackages,
      versions,
      options.packageImportResolver,
    );
    for (const entry of [...FRAMEWORK_PACKAGE_ENTRIES, uiClientModulePath()]) {
      await authority.authorizeInternal(entry);
    }
    return authority;
  }

  async resolveBare(specifier: string, importer: string): Promise<string> {
    const requestedName = packageNameOf(specifier);
    const canonicalImporter = await realpath(importer || this.entryPath);
    const importingPackage = this.packageForPath(canonicalImporter);
    let expectedVersion: string | undefined;
    if (importingPackage) {
      if (
        requestedName !== importingPackage.identity.name &&
        !importingPackage.dependencies.has(requestedName)
      ) {
        throw new Error(
          `Package ${importingPackage.identity.name} does not declare UI dependency ${requestedName}`,
        );
      }
    } else {
      this.assertWorkspaceAuthored(canonicalImporter);
      if (!this.allowedPackages.has(requestedName)) {
        throw new Error(`Package import ${requestedName} is not allow-listed for this UI component`);
      }
      expectedVersion = this.allowedPackageVersions[requestedName];
    }

    const adapterResolved = importingPackage ? undefined : this.packageImportResolver?.(specifier);
    let resolvedPath: string;
    if (adapterResolved !== undefined) {
      if (!isAbsolute(adapterResolved)) {
        throw new Error(`Adapter package resolver returned a non-absolute path for ${specifier}`);
      }
      resolvedPath = adapterResolved;
    } else {
      try {
        resolvedPath = createRequire(canonicalImporter).resolve(specifier);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not resolve authorized UI package import ${specifier}: ${message}`);
      }
    }
    const canonicalTarget = await realpath(resolvedPath);
    const targetPackage = await this.packageIdentityFor(canonicalTarget);
    if (targetPackage.identity.name !== requestedName) {
      throw new Error(
        `UI package import ${specifier} resolved to unexpected package ${targetPackage.identity.name}`,
      );
    }
    if (expectedVersion && targetPackage.identity.version !== expectedVersion) {
      throw new Error(
        `UI package ${requestedName} resolved to ${targetPackage.identity.version}, expected ${expectedVersion}`,
      );
    }
    this.authorizedPackages.set(pathKey(targetPackage.root), targetPackage);
    const parent = importingPackage
      ? this.packageResolutions.get(pathKey(importingPackage.root))?.steps ?? []
      : [];
    const step = importingPackage
      ? {
          specifier,
          importer: {
            kind: 'package' as const,
            // Resolver caches may deduplicate the same specifier from sibling
            // files and report either importer. The package manifest is the
            // stable resolution anchor for every file in the package.
            path: 'package.json',
            package: importingPackage.identity,
          },
        }
      : {
          specifier,
          importer: {
            kind: 'workspace' as const,
            path: canonicalRelativePath(this.workspaceRoot, canonicalImporter),
          },
        };
    const resolution: ReactUiPackageResolution = {
      schemaVersion: 1,
      steps: [...parent, step],
    };
    const resolutionKey = pathKey(targetPackage.root);
    const existingResolution = this.packageResolutions.get(resolutionKey);
    if (
      !existingResolution ||
      resolution.steps.length < existingResolution.steps.length ||
      (
        resolution.steps.length === existingResolution.steps.length &&
        JSON.stringify(resolution).localeCompare(JSON.stringify(existingResolution)) < 0
      )
    ) {
      this.packageResolutions.set(resolutionKey, resolution);
    }
    return canonicalTarget;
  }

  async assertLoadAllowed(requestedPath: string, canonicalPath: string): Promise<void> {
    if (this.packageForPath(canonicalPath)) return;
    if (!isContainedPath(this.workspaceRoot, canonicalPath) || isNodeModulesPath(this.workspaceRoot, canonicalPath)) {
      throw new Error(`component dependency is not within the authored workspace or an authorized package: ${canonicalPath}`);
    }
    await assertNoWorkspaceSymlinks(this.workspaceRoot, requestedPath);
  }

  async assertRelativeImport(importer: string, specifier: string): Promise<void> {
    const canonicalImporter = await realpath(importer);
    const lexicalTarget = resolve(dirname(canonicalImporter), specifier);
    const importingPackage = this.packageForPath(canonicalImporter);
    if (importingPackage && !isContainedPath(importingPackage.root, lexicalTarget)) {
      throw new Error(
        `Package ${importingPackage.identity.name} relative import escapes its authorized package root`,
      );
    }
    if (!importingPackage) {
      this.assertWorkspaceAuthored(canonicalImporter);
      if (!isContainedPath(this.workspaceRoot, lexicalTarget) || isNodeModulesPath(this.workspaceRoot, lexicalTarget)) {
        throw new Error('Authored workspace relative import escapes into an unauthorized package or external path');
      }
    }
  }

  packageForPath(path: string): AuthorizedPackage | undefined {
    return [...this.authorizedPackages.values()]
      .filter((record) => isContainedPath(record.root, path))
      .sort((left, right) => right.root.length - left.root.length)[0];
  }

  resolutionForPath(path: string): ReactUiPackageResolution | undefined {
    const owner = this.packageForPath(path);
    return owner ? this.packageResolutions.get(pathKey(owner.root)) : undefined;
  }

  async resolveAttestedPackageInput(input: ReactUiBuildInputAttestation): Promise<string> {
    if (input.kind !== 'package' || !input.package) {
      throw new Error('Expected an attested package UI input');
    }
    let targetPackage: AuthorizedPackage;
    if (input.resolution) {
      let resolvedPackage: AuthorizedPackage | undefined;
      for (const step of input.resolution.steps) {
        let importer: string;
        if (step.importer.kind === 'workspace') {
          importer = resolve(this.workspaceRoot, step.importer.path);
          const canonicalImporter = await realpath(importer);
          this.assertWorkspaceAuthored(canonicalImporter);
          importer = canonicalImporter;
        } else {
          const importerPackage = resolvedPackage ?? await this.resolveAttestedPackageRoot(step.importer.package);
          assertPackageIdentity(importerPackage.identity, step.importer.package);
          importer = await realpath(resolve(importerPackage.root, step.importer.path));
          if (!isContainedPath(importerPackage.root, importer)) {
            throw new Error(`Attested UI package importer escaped ${importerPackage.identity.name}`);
          }
        }
        let resolved = step.importer.kind === 'workspace'
          ? this.packageImportResolver?.(step.specifier)
          : undefined;
        if (resolved !== undefined && !isAbsolute(resolved)) {
          throw new Error(`Adapter package resolver returned a non-absolute path for ${step.specifier}`);
        }
        resolved ??= createRequire(importer).resolve(step.specifier);
        resolvedPackage = await findAuthorizedPackage(await realpath(resolved));
      }
      if (!resolvedPackage) throw new Error('Attested UI package resolution chain is empty');
      targetPackage = resolvedPackage;
    } else {
      targetPackage = await this.resolveAttestedPackageRoot(input.package);
    }
    assertPackageIdentity(targetPackage.identity, input.package);
    const target = resolve(targetPackage.root, input.path);
    if (!isContainedPath(targetPackage.root, target)) {
      throw new Error(`Attested UI package input escaped ${input.package.name}`);
    }
    const canonical = await realpath(target);
    if (!isContainedPath(targetPackage.root, canonical)) {
      throw new Error(`Attested UI package input resolved outside ${input.package.name}`);
    }
    return canonical;
  }

  private async resolveAttestedPackageRoot(identity: ReactUiPackageIdentity): Promise<AuthorizedPackage> {
    let resolvedEntry: string | undefined;
    if (identity.name === 'react') resolvedEntry = requireFromPackage.resolve('react');
    else if (identity.name === 'react-dom') resolvedEntry = requireFromPackage.resolve('react-dom');
    else {
      const runtime = await findAuthorizedPackage(await realpath(uiClientModulePath()));
      if (runtime.identity.name === identity.name) resolvedEntry = uiClientModulePath();
      else resolvedEntry = this.packageImportResolver?.(identity.name);
    }
    if (!resolvedEntry) resolvedEntry = createRequire(this.entryPath).resolve(identity.name);
    const targetPackage = await findAuthorizedPackage(await realpath(resolvedEntry));
    assertPackageIdentity(targetPackage.identity, identity);
    return targetPackage;
  }

  private async authorizeInternal(path: string): Promise<void> {
    const record = await this.packageIdentityFor(await realpath(path));
    this.authorizedPackages.set(pathKey(record.root), record);
  }

  private assertWorkspaceAuthored(path: string): void {
    if (!isContainedPath(this.workspaceRoot, path) || isNodeModulesPath(this.workspaceRoot, path)) {
      throw new Error(`UI package authority cannot originate outside authored workspace code: ${path}`);
    }
  }

  private packageIdentityFor(path: string): Promise<AuthorizedPackage> {
    const directory = dirname(path);
    const key = pathKey(directory);
    let pending = this.packageCache.get(key);
    if (!pending) {
      pending = findAuthorizedPackage(path);
      this.packageCache.set(key, pending);
    }
    return pending;
  }
}

class BuildSnapshotCollector {
  private readonly captured = new Map<string, CapturedBuildInput>();

  private constructor(
    private readonly workspaceRoot: string,
    private readonly entryPath: string,
    private readonly authority: PackageImportAuthority,
    private readonly buildObserver: ReactUiCompilerOptions['buildObserver'],
  ) {}

  static async create(options: {
    workspacePath: string;
    entryPath: string;
    authority: PackageImportAuthority;
    buildObserver: ReactUiCompilerOptions['buildObserver'];
  }): Promise<BuildSnapshotCollector> {
    return new BuildSnapshotCollector(
      await realpath(resolve(options.workspacePath)),
      await realpath(options.entryPath),
      options.authority,
      options.buildObserver,
    );
  }

  plugin(): Plugin {
    return {
      name: 'marshal-ui-immutable-build-snapshot',
      setup: (buildContext) => {
        buildContext.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
          this.buildObserver?.({ phase: 'load', path: args.path });
          const canonicalPath = await realpath(args.path);
          await this.authority.assertLoadAllowed(args.path, canonicalPath);
          const captured = await this.capture(canonicalPath);
          return {
            contents: captured.bytes,
            loader: loaderFor(canonicalPath),
            resolveDir: dirname(canonicalPath),
          };
        });
      },
    };
  }

  async captureWorkspaceConfigs(): Promise<void> {
    for (const path of await relevantWorkspaceConfigPaths(this.workspaceRoot, this.entryPath)) {
      await this.capture(path);
    }
  }

  digestFor(path: string): string {
    const captured = this.captured.get(pathKey(path));
    if (!captured) throw new Error(`UI build did not load its registered entry: ${path}`);
    return captured.digest;
  }

  byteLengthFor(path: string): number {
    const captured = this.captured.get(pathKey(path));
    if (!captured) throw new Error(`UI build did not load its registered entry: ${path}`);
    return captured.bytes.byteLength;
  }

  async attestation(): Promise<ReactUiBuildGraphAttestation> {
    const runtime = this.authority.packageForPath(await realpath(uiClientModulePath()));
    if (!runtime) throw new Error('Marshal UI client package was not authorized');
    const inputs: ReactUiBuildInputAttestation[] = [
      runtimeInput('marshal-react-ui-entry.tsx', bootstrapSource(), runtime.identity),
      runtimeInput('marshal-storage-bootstrap.js', STORAGE_BOOTSTRAP, runtime.identity),
      runtimeInput('marshal-runtime-bootstrap.js', RUNTIME_BOOTSTRAP, runtime.identity),
      runtimeInput('marshal-default-style.css', DEFAULT_STYLE, runtime.identity),
      runtimeInput(BUNDLE_OPTIONS_INPUT_PATH, BUNDLE_OPTIONS_CONTENTS, runtime.identity),
    ];
    for (const captured of this.captured.values()) {
      inputs.push(await this.describe(captured));
    }
    return canonicalGraph({ schemaVersion: GRAPH_SCHEMA_VERSION, inputs });
  }

  private async describe(captured: CapturedBuildInput): Promise<ReactUiBuildInputAttestation> {
    const resolved = this.authority.packageForPath(captured.canonicalPath);
    if (!resolved) {
      return {
        kind: 'workspace',
        path: canonicalRelativePath(this.workspaceRoot, captured.canonicalPath),
        digest: captured.digest,
      };
    }
    return {
      kind: 'package',
      path: canonicalRelativePath(resolved.root, captured.canonicalPath),
      digest: captured.digest,
      package: resolved.identity,
      ...(this.authority.resolutionForPath(captured.canonicalPath)
        ? { resolution: this.authority.resolutionForPath(captured.canonicalPath) }
        : {}),
    };
  }

  private async capture(canonicalPath: string): Promise<CapturedBuildInput> {
    let captured = this.captured.get(pathKey(canonicalPath));
    if (!captured) {
      const bytes = await readStableFile(canonicalPath);
      captured = { canonicalPath, bytes, digest: digest(bytes) };
      this.captured.set(pathKey(canonicalPath), captured);
    }
    return captured;
  }

}

function runtimeInput(
  path: string,
  contents: string,
  packageIdentity: ReactUiPackageIdentity,
): ReactUiBuildInputAttestation {
  return {
    kind: 'package',
    path: `__marshal__/${path}`,
    digest: digest(contents),
    package: packageIdentity,
  };
}

function runtimeInputContents(path: string): string | undefined {
  switch (path) {
    case '__marshal__/marshal-react-ui-entry.tsx': return bootstrapSource();
    case '__marshal__/marshal-storage-bootstrap.js': return STORAGE_BOOTSTRAP;
    case '__marshal__/marshal-runtime-bootstrap.js': return RUNTIME_BOOTSTRAP;
    case '__marshal__/marshal-default-style.css': return DEFAULT_STYLE;
    case `__marshal__/${BUNDLE_OPTIONS_INPUT_PATH}`: return BUNDLE_OPTIONS_CONTENTS;
    default: return undefined;
  }
}

async function relevantWorkspaceConfigPaths(
  workspacePath: string,
  entryPath: string,
): Promise<string[]> {
  const root = await realpath(resolve(workspacePath));
  const entry = await realpath(entryPath);
  if (!isContainedPath(root, entry)) throw new Error('UI entry is outside the workspace');
  const directories: string[] = [];
  let current = dirname(entry);
  for (;;) {
    directories.push(current);
    if (pathKey(current) === pathKey(root)) break;
    const parent = dirname(current);
    if (parent === current || !isContainedPath(root, parent)) break;
    current = parent;
  }
  const configs: string[] = [];
  for (const directory of directories) {
    for (const name of ['package.json', 'tsconfig.json', 'jsconfig.json']) {
      const candidate = resolve(directory, name);
      try {
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const canonical = await realpath(candidate);
        if (isContainedPath(root, canonical)) configs.push(canonical);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return [...new Set(configs.map(pathKey))]
    .map((key) => configs.find((path) => pathKey(path) === key)!)
    .sort((left, right) => left.localeCompare(right));
}

async function readStableFile(path: string): Promise<Uint8Array> {
  const canonicalBefore = await realpath(path);
  if (pathKey(canonicalBefore) !== pathKey(path)) {
    throw new Error(`UI build input changed canonical path before it was snapshotted: ${path}`);
  }
  const pathBefore = await lstat(path);
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error(`UI build input is not a direct regular file: ${path}`);
  }
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`UI build input is not a regular file: ${path}`);
    if (!sameStableFileIdentity(pathBefore, before)) {
      throw new Error(`UI build input changed identity while it was being opened: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    const canonicalAfter = await realpath(path);
    if (
      pathAfter.isSymbolicLink() ||
      !sameFileSnapshot(before, after) ||
      !sameStableFileIdentity(after, pathAfter) ||
      pathKey(canonicalBefore) !== pathKey(canonicalAfter)
    ) {
      throw new Error(`UI build input changed while it was being snapshotted: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameFileSnapshot(
  left: { dev: number; ino: number; size: number; mode: number; birthtimeMs: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mode: number; birthtimeMs: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return sameStableFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function findAuthorizedPackage(path: string): Promise<AuthorizedPackage> {
  let current = dirname(path);
  for (;;) {
    const manifestPath = resolve(current, 'package.json');
    try {
      const canonicalManifest = await realpath(manifestPath);
      if (!isContainedPath(current, canonicalManifest)) {
        throw new Error(`Package manifest resolves outside its package root: ${manifestPath}`);
      }
      const manifestBytes = await readStableFile(canonicalManifest);
      const parsed = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as {
        name?: unknown;
        version?: unknown;
        dependencies?: unknown;
        optionalDependencies?: unknown;
        peerDependencies?: unknown;
      };
      if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
        throw new Error(`Package manifest has no valid name: ${canonicalManifest}`);
      }
      if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
        throw new Error(`Package manifest has no valid version: ${canonicalManifest}`);
      }
      return {
        root: await realpath(current),
        identity: {
          name: parsed.name,
          version: parsed.version,
          manifestDigest: digest(manifestBytes),
        },
        dependencies: new Set([
          ...dependencyNames(parsed.dependencies, canonicalManifest),
          ...dependencyNames(parsed.optionalDependencies, canonicalManifest),
          ...dependencyNames(parsed.peerDependencies, canonicalManifest),
        ]),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`UI package input has no canonical package identity: ${path}`);
    }
    current = parent;
  }
}

function dependencyNames(value: unknown, manifestPath: string): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Package dependencies must be an object: ${manifestPath}`);
  }
  return Object.keys(value as Record<string, unknown>).map(packageNameOf);
}

function loaderFor(path: string): 'tsx' | 'ts' | 'jsx' | 'js' | 'css' | 'json' | 'text' | 'dataurl' {
  switch (extname(path).toLowerCase()) {
    case '.tsx': return 'tsx';
    case '.ts': return 'ts';
    case '.jsx': return 'jsx';
    case '.js':
    case '.mjs':
    case '.cjs': return 'js';
    case '.css': return 'css';
    case '.json': return 'json';
    case '.txt': return 'text';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.svg':
    case '.woff':
    case '.woff2': return 'dataurl';
    default: throw new Error(`Unsupported UI build input extension: ${path}`);
  }
}

function assertBuildGraphMatches(
  expected: ReactUiBuildGraphAttestation,
  actual: ReactUiBuildGraphAttestation,
  componentId: string,
): void {
  const expectedCanonical = canonicalGraph(expected);
  const actualCanonical = canonicalGraph(actual);
  if (JSON.stringify(expectedCanonical) === JSON.stringify(actualCanonical)) return;
  const expectedInputs = new Map(expectedCanonical.inputs.map((input) => [graphInputKey(input), input]));
  const actualInputs = new Map(actualCanonical.inputs.map((input) => [graphInputKey(input), input]));
  const changed = [...new Set([...expectedInputs.keys(), ...actualInputs.keys()])]
    .filter((key) => JSON.stringify(expectedInputs.get(key)) !== JSON.stringify(actualInputs.get(key)))
    .slice(0, 3);
  throw new Error(
    `Registered UI component ${componentId} no longer matches its audited build graph${changed.length ? ` (${changed.join(', ')})` : ''}`,
  );
}

function graphDigest(graph: ReactUiBuildGraphAttestation): string {
  return digest(JSON.stringify(canonicalGraph(graph)));
}

function canonicalGraph(graph: ReactUiBuildGraphAttestation): ReactUiBuildGraphAttestation {
  if (graph.schemaVersion !== GRAPH_SCHEMA_VERSION || !Array.isArray(graph.inputs)) {
    throw new Error('Registered UI build graph must use schema version 1');
  }
  const inputs = graph.inputs.map((input) => canonicalGraphInput(input));
  inputs.sort((left, right) => graphInputKey(left).localeCompare(graphInputKey(right)));
  const keys = inputs.map(graphInputKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Registered UI build graph contains duplicate canonical inputs');
  }
  return { schemaVersion: GRAPH_SCHEMA_VERSION, inputs };
}

function immutableGraph(graph: ReactUiBuildGraphAttestation): ReactUiBuildGraphAttestation {
  const canonical = canonicalGraph(graph);
  return Object.freeze({
    schemaVersion: GRAPH_SCHEMA_VERSION,
    inputs: Object.freeze(canonical.inputs.map((input) => Object.freeze({
      ...input,
      package: input.package ? Object.freeze({ ...input.package }) : undefined,
      resolution: input.resolution ? Object.freeze({
        schemaVersion: 1 as const,
        steps: Object.freeze(input.resolution.steps.map((step) => Object.freeze({
          specifier: step.specifier,
          importer: Object.freeze(step.importer.kind === 'workspace'
            ? { kind: 'workspace' as const, path: step.importer.path }
            : { kind: 'package' as const, path: step.importer.path, package: Object.freeze({ ...step.importer.package }) }),
        }))),
      }) : undefined,
    }))),
  });
}

function canonicalGraphInput(input: ReactUiBuildInputAttestation): ReactUiBuildInputAttestation {
  if (input.kind !== 'workspace' && input.kind !== 'package') {
    throw new Error('Registered UI build input kind is invalid');
  }
  assertCanonicalRelativePath(input.path);
  if (!DIGEST_PATTERN.test(input.digest)) {
    throw new Error(`Registered UI build input has an invalid digest: ${input.path}`);
  }
  if (input.kind === 'workspace') {
    if (input.package !== undefined || input.resolution !== undefined) {
      throw new Error(`Workspace UI build input may not declare a package: ${input.path}`);
    }
    return { kind: 'workspace', path: input.path, digest: input.digest };
  }
  const identity = input.package;
  if (!identity || !identity.name.trim() || !identity.version.trim() || !DIGEST_PATTERN.test(identity.manifestDigest)) {
    throw new Error(`Package UI build input has invalid package identity: ${input.path}`);
  }
  const resolution = input.resolution === undefined
    ? undefined
    : canonicalPackageResolution(input.resolution);
  return {
    kind: 'package',
    path: input.path,
    digest: input.digest,
    package: {
      name: identity.name,
      version: identity.version,
      manifestDigest: identity.manifestDigest,
    },
    ...(resolution ? { resolution } : {}),
  };
}

function canonicalPackageResolution(resolution: ReactUiPackageResolution): ReactUiPackageResolution {
  if (resolution.schemaVersion !== 1 || !Array.isArray(resolution.steps) ||
    resolution.steps.length === 0 || resolution.steps.length > 256) {
    throw new Error('Package UI build input has invalid resolution provenance');
  }
  return {
    schemaVersion: 1,
    steps: resolution.steps.map((step) => {
      if (!isBareSpecifier(step.specifier)) throw new Error('Package resolution specifier must be bare');
      assertCanonicalRelativePath(step.importer.path);
      if (step.importer.kind === 'workspace') {
        return { specifier: step.specifier, importer: { kind: 'workspace', path: step.importer.path } };
      }
      if (step.importer.kind !== 'package') throw new Error('Package resolution importer is invalid');
      const identity = step.importer.package;
      if (!identity.name.trim() || !identity.version.trim() || !DIGEST_PATTERN.test(identity.manifestDigest)) {
        throw new Error('Package resolution importer identity is invalid');
      }
      return {
        specifier: step.specifier,
        importer: { kind: 'package', path: step.importer.path, package: { ...identity } },
      };
    }),
  };
}

function assertPackageIdentity(actual: ReactUiPackageIdentity, expected: ReactUiPackageIdentity): void {
  if (actual.name !== expected.name || actual.version !== expected.version ||
    actual.manifestDigest !== expected.manifestDigest) {
    throw new Error(`UI package identity drifted for ${expected.name}`);
  }
}

function graphInputKey(input: ReactUiBuildInputAttestation): string {
  return input.kind === 'workspace'
    ? `workspace:${input.path}`
    : `package:${input.package?.name}@${input.package?.version}:${input.path}:${input.resolution ? JSON.stringify(input.resolution) : 'legacy'}`;
}

function assertCanonicalRelativePath(path: string): void {
  if (!path || path.includes('\\') || isAbsolute(path)) {
    throw new Error(`Registered UI build input path is not canonical: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Registered UI build input path is not canonical: ${path}`);
  }
}

function canonicalRelativePath(root: string, path: string): string {
  if (!isContainedPath(root, path)) throw new Error(`UI build input resolves outside its canonical root: ${path}`);
  const result = normalizePath(relative(root, path));
  assertCanonicalRelativePath(result);
  return result;
}

function isContainedPath(root: string, target: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const normalizedTarget = process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target);
  const value = relative(normalizedRoot, normalizedTarget);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function componentResolutionPlugin(
  entryPath: string,
  authority: PackageImportAuthority,
  buildObserver: ReactUiCompilerOptions['buildObserver'],
): Plugin {
  return {
    name: 'marshal-ui-import-policy',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^__marshal_component__$/ }, () => ({ path: entryPath }));
      buildContext.onResolve({ filter: /^__marshal_ui_client__$/ }, () => ({
        path: uiClientModulePath(),
      }));
      buildContext.onResolve({ filter: /^@marshal\/agent-runtime-ui$/ }, () => ({
        path: uiClientModulePath(),
      }));
      buildContext.onResolve({ filter: /.*/ }, async (args) => {
        buildObserver?.({ phase: 'resolve', path: args.path, ...(args.importer ? { importer: args.importer } : {}) });
        if (args.path === '__marshal_component__') return { path: entryPath };
        const frameworkImport = FRAMEWORK_IMPORTS.get(args.path);
        if (frameworkImport) return { path: frameworkImport };
        if (BLOCKED_SPECIFIERS.has(args.path) || args.path.startsWith('node:')) {
          return { errors: [{ text: `Node built-in import is unavailable in UI: ${args.path}` }] };
        }
        if (/^(?:https?:|data:|blob:)/i.test(args.path)) {
          return { errors: [{ text: `URL imports are unavailable in UI: ${args.path}` }] };
        }
        if (isAbsolute(args.path)) {
          return { errors: [{ text: `Absolute imports are unavailable in authored UI: ${args.path}` }] };
        }
        if (args.path.startsWith('.') && args.importer) {
          try {
            await authority.assertRelativeImport(args.importer, args.path);
            return undefined;
          } catch (error) {
            return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
          }
        }
        if (isBareSpecifier(args.path)) {
          try {
            return { path: await authority.resolveBare(args.path, args.importer || entryPath) };
          } catch (error) {
            return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
          }
        }
        return undefined;
      });
    },
  };
}

function mergePackages(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): readonly string[] {
  return [...new Set([...(first ?? []), ...(second ?? [])])];
}

function bootstrapSource(): string {
  return `import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MarshalUiClient, createWindowParentTransport} from '__marshal_ui_client__';
import Component from '__marshal_component__';

function selectProps(message) {
  const structured = message?.params?.structuredContent;
  if (!structured || typeof structured !== 'object') return undefined;
  const props = structured.props;
  return props && typeof props === 'object' && !Array.isArray(props) ? props : undefined;
}

function MarshalRoot() {
  const [props, setProps] = useState(() => {
    const initial = window.__MARSHAL_INITIAL_PROPS__;
    return initial && typeof initial === 'object' && !Array.isArray(initial) ? initial : {};
  });
  const [marshal, setMarshal] = useState(() => window.__MARSHAL_UI_CLIENT__);
  const application = window.__MARSHAL_APPLICATION__;
  const renderId = window.__MARSHAL_RENDER_ID__;
  useEffect(() => {
    const receive = (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== '2.0') return;
      if (message.method !== 'ui/notifications/tool-result' && message.method !== 'ui/notifications/tool-input') return;
      const next = selectProps(message);
      if (next) setProps(next);
    };
    window.addEventListener('message', receive, {passive: true});
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    if (marshal) return;
    if (!application || typeof application !== 'object' || typeof renderId !== 'string') return;
    let active = true;
    MarshalUiClient.connect({
      appInfo: {name: 'marshal-authored-react', version: '1.0.0'},
      application,
      renderId,
      transport: createWindowParentTransport('*'),
    }).then(client => {
      if (!active) { client.close(); return; }
      window.__MARSHAL_UI_CLIENT__ = client;
      setMarshal(client);
      window.dispatchEvent(new CustomEvent('marshal:ready', {detail: client}));
    }).catch(error => {
      window.dispatchEvent(new CustomEvent('marshal:error', {detail: String(error && error.message || error)}));
    });
    return () => { active = false; };
  }, [marshal]);
  useEffect(() => () => { if (marshal) marshal.close(); }, [marshal]);
  if (!marshal && application && typeof application === 'object' && typeof renderId === 'string') {
    return React.createElement('main', {'aria-busy': 'true'}, 'Connecting interface…');
  }
  return React.createElement(Component, {...props, marshal});
}

createRoot(document.getElementById('root')).render(React.createElement(MarshalRoot));
if (typeof ResizeObserver === 'function') {
  const reportSize = () => window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:Math.ceil(document.documentElement.scrollWidth),height:Math.ceil(document.documentElement.scrollHeight)}}, '*');
  new ResizeObserver(reportSize).observe(document.documentElement);
  requestAnimationFrame(reportSize);
}
`;
}

function uiClientModulePath(): string {
  const javascript = fileURLToPath(new URL('./client.js', import.meta.url));
  if (existsSync(javascript)) return javascript;
  const typescript = fileURLToPath(new URL('./client.ts', import.meta.url));
  if (existsSync(typescript)) return typescript;
  throw new Error('Marshal UI client module is unavailable beside the compiler.');
}

function renderHtml(title: string, script: string, style: string): string {
  const scriptHash = cspHash(script);
  const csp = [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    'img-src data: blob:',
    'font-src data:',
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="marshal-props" content=""><meta name="marshal-storage" content=""><meta name="marshal-runtime" content=""><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><main id="root" aria-live="polite"></main><script>${script}</script></body></html>`;
}

function cspHash(value: string): string {
  return `sha256-${Buffer.from(digestBytes(value)).toString('base64')}`;
}

function digestBytes(value: string): Uint8Array {
  return Buffer.from(digest(value), 'hex');
}

function isBareSpecifier(value: string): boolean {
  return !value.startsWith('.') && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value);
}

function packageNameOf(specifier: string): string {
  const [first, second] = specifier.split('/');
  const name = first.startsWith('@') ? `${first}/${second ?? ''}` : first;
  if (name === '*') return name;
  if (!/^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)$/.test(name)) {
    throw new Error(`Invalid UI package name: ${specifier}`);
  }
  return name;
}

function isNodeModulesPath(root: string, target: string): boolean {
  const path = normalizePath(relative(root, target));
  return path === 'node_modules' || path.startsWith('node_modules/') || path.includes('/node_modules/');
}

async function assertNoWorkspaceSymlinks(root: string, requestedPath: string): Promise<void> {
  const target = resolve(requestedPath);
  if (!isContainedPath(root, target)) {
    throw new Error(`component dependency resolves outside the workspace: ${requestedPath}`);
  }
  let current = resolve(root);
  for (const segment of relative(current, target).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Symbolic links are unavailable in authored workspace UI dependencies: ${requestedPath}`);
    }
  }
}

function boundedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return value;
}

function optionalText(value: string | undefined, field: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, field, maxLength);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character,
  );
}

export { MIME_TYPE as REACT_UI_MCP_APP_MIME_TYPE };
