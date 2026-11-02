import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import {
  context as createBuildContext,
  type BuildOptions,
  type BuildResult,
  type Loader,
  type Message,
  type OnResolveArgs,
  type OnResolveResult,
  type Plugin,
  type PluginBuild,
} from 'esbuild';
import ts from 'typescript';
import type {
  TypeScriptExecutionDiagnostic,
  TypeScriptExecutionMode,
  TypeScriptModuleSourceKind,
} from './types.js';
import {
  appServicePublicNames,
  type AppServicesSnapshot,
} from './appServices.js';

const ENTRY_POINT = 'agent-runtime-inline-entry';
const ENTRY_NAMESPACE = 'agent-runtime-inline';
const WORKSPACE_NAMESPACE = 'agent-runtime-workspace';
const CONTRACTS_NAMESPACE = 'agent-runtime-contracts';
const APP_SERVICES_NAMESPACE = 'agent-runtime-app-services';
const TYPE_SYMBOLS_NAMESPACE = 'agent-runtime-type-symbols';
const BUILTINS = new Set(
  builtinModules.map((name) => (name.startsWith('node:') ? name.slice(5) : name)),
);

export class CompilationFailure extends Error {
  readonly diagnostics: TypeScriptExecutionDiagnostic[];
  readonly code: string;

  constructor(code: string, message: string, diagnostics: TypeScriptExecutionDiagnostic[]) {
    super(message);
    this.name = 'CompilationFailure';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface CompileInlineModuleRequest {
  source: string;
  filename: string;
  workingDirectory: string;
  mode: TypeScriptExecutionMode;
  allowedPackages: ReadonlySet<string>;
  allowedBuiltins: ReadonlySet<string>;
  sourceKind?: TypeScriptModuleSourceKind;
  workspaceRoot?: string;
  appServices?: AppServicesSnapshot;
}

export interface CompileInlineModuleResult {
  code: string;
  diagnostics: TypeScriptExecutionDiagnostic[];
  requiredBuiltins: string[];
  importedPackages: string[];
  localFiles: Array<{ path: string; contentDigest: string; sizeBytes: number }>;
}

export interface InlineModuleCompilationSession {
  compile(): Promise<CompileInlineModuleResult>;
  dispose(): Promise<void>;
}

function loaderFor(filename: string): Loader {
  switch (path.extname(filename).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.tsx':
      return 'tsx';
    default:
      return 'ts';
  }
}

function normalizeBuiltin(specifier: string): string | undefined {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return BUILTINS.has(name) ? name : undefined;
}

function packageNameFor(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

function deniedImport(specifier: string, reason: string): OnResolveResult {
  return { errors: [{ text: `[IMPORT_DENIED] Import "${specifier}" is denied: ${reason}` }] };
}

function importPolicyPlugin(
  request: CompileInlineModuleRequest,
  importedPackages: Set<string>,
  localFiles: Map<string, { path: string; contentDigest: string; sizeBytes: number }>,
  sourceContents: Map<string, string>,
): Plugin {
  const virtualModules = virtualModuleSources(request.appServices);
  return {
    name: 'agent-runtime-import-policy',
    setup(context) {
      context.onResolve({ filter: new RegExp(`^${ENTRY_POINT}$`) }, (args) =>
        args.kind === 'entry-point'
          ? { path: request.filename, namespace: ENTRY_NAMESPACE }
          : undefined,
      );

      context.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, () => ({
        contents: request.source,
        loader: loaderFor(request.filename),
        resolveDir:
          request.sourceKind === 'workspace_file'
            ? path.dirname(request.filename)
            : request.workingDirectory,
      }));
      sourceContents.set(
        path.normalize(path.resolve(request.workingDirectory, request.filename)),
        request.source,
      );

      context.onLoad({ filter: /.*/, namespace: WORKSPACE_NAMESPACE }, async (args) => {
        const workspaceRoot = await realWorkspaceRoot(request);
        const safePath = await assertSafeWorkspaceFile(workspaceRoot, args.path);
        const contents = await fs.readFile(safePath);
        sourceContents.set(path.normalize(safePath), contents.toString('utf8'));
        localFiles.set(safePath, {
          path: path.relative(workspaceRoot, safePath).split(path.sep).join('/'),
          contentDigest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
          sizeBytes: contents.length,
        });

        return {
          contents,
          loader: loaderFor(safePath),
          resolveDir: path.dirname(safePath),
        };
      });

      context.onResolve({ filter: /^marshal:(contracts|app-services|type-symbols)$/ }, (args) => ({
        path: args.path,
        namespace: args.path === 'marshal:contracts'
          ? CONTRACTS_NAMESPACE
          : args.path === 'marshal:app-services'
            ? APP_SERVICES_NAMESPACE
            : TYPE_SYMBOLS_NAMESPACE,
      }));
      for (const [namespace, source] of virtualModules) {
        context.onLoad({ filter: /.*/, namespace }, () => ({
          contents: source,
          loader: 'ts',
        }));
      }

      const resolveImport = (args: OnResolveArgs) =>
        resolveModuleImport(context, request, importedPackages, args);
      context.onResolve({ filter: /.*/, namespace: ENTRY_NAMESPACE }, resolveImport);
      context.onResolve({ filter: /.*/, namespace: WORKSPACE_NAMESPACE }, resolveImport);
    },
  };
}

function virtualModuleSources(snapshot: AppServicesSnapshot | undefined): ReadonlyMap<string, string> {
  const declarations = snapshot?.declarations ?? '';
  const appServices = [
    declarations,
    'export const AppServices = globalThis.AppServices;',
    'export default AppServices;',
  ].join('\n');
  const typeSymbols = [
    declarations,
    'export const TypeSymbols = globalThis.TypeSymbols;',
    'export default TypeSymbols;',
  ].join('\n');
  return new Map([
    [CONTRACTS_NAMESPACE, declarations || 'export {};'],
    [APP_SERVICES_NAMESPACE, appServices],
    [TYPE_SYMBOLS_NAMESPACE, typeSymbols],
  ]);
}

function semanticVirtualModuleSources(
  snapshot: AppServicesSnapshot | undefined,
): ReadonlyMap<string, string> {
  const declarations = snapshot?.declarations ?? '';
  return new Map([
    [CONTRACTS_NAMESPACE, declarations || 'export {};'],
    [APP_SERVICES_NAMESPACE, [
      declarations,
      'export declare const AppServices: AppServices;',
      'export default AppServices;',
    ].join('\n')],
    [TYPE_SYMBOLS_NAMESPACE, [
      declarations,
      typeSymbolsDeclaration(snapshot),
      'export default TypeSymbols;',
    ].join('\n')],
  ]);
}

function typeSymbolsDeclaration(snapshot: AppServicesSnapshot | undefined): string {
  const services = snapshot?.services ?? [];
  const names = appServicePublicNames(services);
  const properties = services
    .map((service) => {
      const publicName = names.get(service.token);
      if (!publicName) return undefined;
      const getterName = `get${publicName.charAt(0).toUpperCase()}${publicName.slice(1)}`;
      return `  readonly ${publicName}: __RuntimeTypeSymbol<ReturnType<AppServices['${getterName}']>>;`;
    })
    .filter((property): property is string => property !== undefined);
  return [
    'type __RuntimeTypeSymbol<T> = symbol & { readonly __type?: (value: T) => T };',
    'export declare const TypeSymbols: {',
    '  create<T>(token: string): __RuntimeTypeSymbol<T>;',
    '  token<T>(type: __RuntimeTypeSymbol<T>): string;',
    ...properties,
    '};',
  ].join('\n');
}

async function resolveModuleImport(
  context: PluginBuild,
  request: CompileInlineModuleRequest,
  importedPackages: Set<string>,
  args: OnResolveArgs,
): Promise<OnResolveResult | undefined> {
  const builtin = normalizeBuiltin(args.path);
  if (builtin) {
    if (
      request.mode === 'trusted' &&
      (request.allowedBuiltins.has('*') || request.allowedBuiltins.has(builtin))
    ) {
      return { path: `node:${builtin}`, external: true };
    }

    return deniedImport(
      args.path,
      request.mode === 'brokered'
        ? 'brokered modules cannot import Node builtins'
        : `builtin "${builtin}" is not in allowedBuiltins`,
    );
  }

  const isRelative = args.path.startsWith('.');
  const isAbsolute = path.isAbsolute(args.path);
  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(args.path);
  if (isRelative || isAbsolute || hasProtocol) {
    if (isRelative && request.sourceKind === 'workspace_file' && !hasProtocol) {
      const workspaceRoot = await realWorkspaceRoot(request);
      const resolved = await context.resolve(args.path, {
        kind: args.kind,
        namespace: 'file',
        resolveDir: args.resolveDir,
      });
      if (resolved.errors.length > 0) {
        return { errors: resolved.errors, warnings: resolved.warnings };
      }
      const safePath = await assertSafeWorkspaceFile(workspaceRoot, resolved.path);
      return {
        path: safePath,
        namespace: WORKSPACE_NAMESPACE,
        sideEffects: resolved.sideEffects,
        warnings: resolved.warnings,
      };
    }

    return deniedImport(
      args.path,
      request.sourceKind === 'workspace_file'
        ? 'workspace modules can import only relative files contained by the workspace'
        : 'inline and artifact modules cannot import files or URLs',
    );
  }

  const packageName = packageNameFor(args.path);
  if (
    request.mode !== 'trusted' ||
    (!request.allowedPackages.has('*') && !request.allowedPackages.has(packageName))
  ) {
    return deniedImport(
      args.path,
      request.mode === 'brokered'
        ? 'brokered modules must use the runtime capability broker'
        : `package "${packageName}" is not in allowedPackages`,
    );
  }
  importedPackages.add(packageName);

  const resolved = await context.resolve(args.path, {
    kind: args.kind,
    namespace: 'file',
    resolveDir: request.workingDirectory,
  });
  if (resolved.errors.length > 0) {
    return { errors: resolved.errors, warnings: resolved.warnings };
  }
  return {
    path: resolved.path,
    external: resolved.external,
    namespace: 'file',
    sideEffects: resolved.sideEffects,
    warnings: resolved.warnings,
  };
}

async function realWorkspaceRoot(request: CompileInlineModuleRequest): Promise<string> {
  if (!request.workspaceRoot) {
    throw new CompilationFailure(
      'WORKSPACE_ROOT_REQUIRED',
      'workspaceRoot is required for workspace-file imports.',
      [],
    );
  }
  return fs.realpath(path.resolve(request.workspaceRoot));
}

function semanticDiagnostics(
  request: CompileInlineModuleRequest,
  sourceFiles: ReadonlyMap<string, string>,
  virtualModules: ReadonlyMap<string, string>,
): TypeScriptExecutionDiagnostic[] {
  if (!['.ts', '.tsx', '.mts', '.cts'].includes(path.extname(request.filename).toLowerCase())) {
    return [];
  }
  const rootFileName = path.resolve(request.workingDirectory, request.filename);
  const virtualFileNames = new Map([
    ['marshal:contracts', path.join(request.workingDirectory, '.marshal-contracts.d.ts')],
    ['marshal:app-services', path.join(request.workingDirectory, '.marshal-app-services.d.ts')],
    ['marshal:type-symbols', path.join(request.workingDirectory, '.marshal-type-symbols.d.ts')],
  ]);
  const knownSources = new Map<string, string>();
  for (const [fileName, source] of sourceFiles) knownSources.set(path.normalize(fileName), source);
  for (const [namespace, source] of virtualModules) {
    const fileName = namespace === CONTRACTS_NAMESPACE
      ? virtualFileNames.get('marshal:contracts')!
      : namespace === APP_SERVICES_NAMESPACE
        ? virtualFileNames.get('marshal:app-services')!
        : virtualFileNames.get('marshal:type-symbols')!;
    knownSources.set(path.normalize(fileName), source);
  }
  knownSources.set(path.normalize(rootFileName), request.source);
  const options: ts.CompilerOptions = {
    allowJs: false,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noImplicitAny: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const moduleResolutionHost: ts.ModuleResolutionHost = {
    fileExists: (fileName) => knownSources.has(path.normalize(fileName)),
    readFile: (fileName) => knownSources.get(path.normalize(fileName)),
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (fileName) =>
    knownSources.has(path.normalize(fileName)) || defaultHost.fileExists(fileName);
  host.readFile = (fileName) => knownSources.get(path.normalize(fileName)) ?? defaultHost.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion) => {
    const source = knownSources.get(path.normalize(fileName));
    return source === undefined
      ? defaultHost.getSourceFile(fileName, languageVersion)
      : ts.createSourceFile(fileName, source, languageVersion, true);
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    const virtualFileName = virtualFileNames.get(moduleName);
    if (virtualFileName) return { resolvedFileName: virtualFileName, extension: ts.Extension.Dts };
    if (!moduleName.startsWith('.')) return undefined;
    return ts.resolveModuleName(moduleName, containingFile, options, moduleResolutionHost).resolvedModule;
  });
  const program = ts.createProgram([rootFileName], options, host);
  return [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]
    .filter((diagnostic) => diagnostic.code !== 2307)
    .map(diagnosticFromTypeScriptDiagnostic);
}

function diagnosticFromTypeScriptDiagnostic(
  diagnostic: ts.Diagnostic,
): TypeScriptExecutionDiagnostic {
  const location = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : undefined;
  return {
    level: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
    code: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    stage: 'compile',
    location: location
      ? {
          file: diagnostic.file?.fileName,
          line: location.line + 1,
          column: location.character + 1,
        }
      : undefined,
  };
}

async function assertSafeWorkspaceFile(workspaceRoot: string, candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  assertContained(workspaceRoot, resolved);
  const relative = path.relative(workspaceRoot, resolved);
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new CompilationFailure(
        'IMPORT_DENIED',
        `Workspace import "${relative}" traverses a symbolic link.`,
        [],
      );
    }
  }
  const real = await fs.realpath(resolved);
  assertContained(workspaceRoot, real);
  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    throw new CompilationFailure(
      'IMPORT_DENIED',
      `Workspace import "${relative}" is not a file.`,
      [],
    );
  }
  return real;
}

function assertContained(workspaceRoot: string, target: string): void {
  const relative = path.relative(workspaceRoot, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CompilationFailure(
      'IMPORT_DENIED',
      `Workspace import escaped the workspace: ${target}`,
      [],
    );
  }
}

function diagnosticFromMessage(
  message: Message,
  level: 'warning' | 'error',
): TypeScriptExecutionDiagnostic {
  return {
    level,
    code: message.text.includes('[IMPORT_DENIED]') ? 'IMPORT_DENIED' : 'COMPILE_ERROR',
    message: message.text.replace(/^\[IMPORT_DENIED\]\s*/, ''),
    stage: 'compile',
    location: message.location
      ? {
          file: message.location.file || undefined,
          line: message.location.line,
          // esbuild columns are 0-based; diagnostic locations are 1-based.
          column: message.location.column + 1,
        }
      : undefined,
  };
}

export async function compileInlineModule(
  request: CompileInlineModuleRequest,
): Promise<CompileInlineModuleResult> {
  const session = await createInlineModuleCompilationSession(request);
  try {
    return await session.compile();
  } finally {
    await session.dispose();
  }
}

export async function createInlineModuleCompilationSession(
  request: CompileInlineModuleRequest,
): Promise<InlineModuleCompilationSession> {
  const importedPackages = new Set<string>();
  const localFiles = new Map<
    string,
    { path: string; contentDigest: string; sizeBytes: number }
  >();
  const sourceContents = new Map<string, string>();
  const buildOptions: BuildOptions = {
    entryPoints: [ENTRY_POINT],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    sourcemap: 'inline',
    sourceRoot: request.sourceKind === 'workspace_file' ? request.workspaceRoot : undefined,
    metafile: true,
    logLevel: 'silent',
    absWorkingDir: request.workingDirectory,
    plugins: [importPolicyPlugin(request, importedPackages, localFiles, sourceContents)],
  };
  const buildContext = await createBuildContext(buildOptions);
  let queue: Promise<void> = Promise.resolve();

  return {
    compile() {
      const operation = queue.then(async () => {
        importedPackages.clear();
        localFiles.clear();
        try {
          const result = await buildContext.rebuild();
          const diagnostics = semanticDiagnostics(
            request,
            sourceContents,
            semanticVirtualModuleSources(request.appServices),
          );
          if (diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
            throw new CompilationFailure(
              'COMPILE_ERROR',
              diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
              diagnostics,
            );
          }
          return compilationResult(result, importedPackages, localFiles);
        } catch (error) {
          throw compilationFailure(error);
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async dispose() {
      await queue;
      await buildContext.dispose();
    },
  };
}

function compilationResult(
  result: BuildResult,
  importedPackages: ReadonlySet<string>,
  localFiles: ReadonlyMap<string, { path: string; contentDigest: string; sizeBytes: number }>,
): CompileInlineModuleResult {
  const output = result.outputFiles?.[0];
  if (!output) throw new CompilationFailure('COMPILE_ERROR', 'esbuild produced no output.', []);
  if (!result.metafile) throw new CompilationFailure('COMPILE_ERROR', 'esbuild produced no metafile.', []);
  return {
    code: output.text,
    diagnostics: result.warnings.map((warning) => diagnosticFromMessage(warning, 'warning')),
    requiredBuiltins: [
      ...new Set(
        Object.values(result.metafile.outputs)
          .flatMap((metadata) => metadata.imports)
          .map((entry) => normalizeBuiltin(entry.path))
          .filter((name): name is string => name !== undefined),
      ),
    ],
    importedPackages: [...importedPackages].sort(),
    localFiles: [...localFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function compilationFailure(error: unknown): CompilationFailure {
  if (error instanceof CompilationFailure) return error;
  const messages =
    typeof error === 'object' && error !== null && 'errors' in error
      ? ((error as { errors?: Message[] }).errors ?? [])
      : [];
  const diagnostics = messages.map((message) => diagnosticFromMessage(message, 'error'));
  const importDenied = diagnostics.some((diagnostic) => diagnostic.code === 'IMPORT_DENIED');
  const message =
    diagnostics.map((diagnostic) => diagnostic.message).join('\n') ||
    (error instanceof Error ? error.message : String(error));
  return new CompilationFailure(
    importDenied ? 'IMPORT_DENIED' : 'COMPILE_ERROR',
    message,
    diagnostics,
  );
}
