import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = {};
const temp = await mkdtemp(join(tmpdir(), 'marshal-runtime-g13-'));
const consumer = join(temp, 'consumer');
const packages = [
  '@marshal/agent-runtime-core',
  '@marshal/agent-runtime-composer',
  '@marshal/agent-runtime-extensions',
  '@marshal/agent-runtime-ui',
  '@marshal/agent-runtime-dsh',
];

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function pass(name) { cases[name] = 'PASS'; }
function fail(name, error) {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
  cases[name] = `FAIL: ${error instanceof Error ? error.message : String(error)}${cause}`;
}
const DSH_COMMIT = '6280fa5168e12a9fdff0f3f7479e4fb89eba0caf';

async function resolvePinnedDshPlugin(destination) {
  const candidates = [
    join(root, 'node_modules', 'dsh-plugin-bridge'),
    join(root, '..', '..', 'node_modules', 'dsh-plugin-bridge'),
  ];
  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(join(candidate, 'package.json'), 'utf8'));
      if (packageJson.version === '0.3.0' && packageJson.main === 'lib/index.js') return candidate;
    } catch {}
  }
  const source = join(destination, 'dsh-plugin-bridge');
  run('git', ['clone', '--quiet', 'https://github.com/Totoro-qaq/dsh-plugin-bridge.git', source]);
  run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', DSH_COMMIT], source);
  const resolved = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  if (resolved.status !== 0 || resolved.stdout.trim() !== DSH_COMMIT) {
    throw new Error(`Pinned DSH source resolved to ${resolved.stdout.trim() || 'unknown commit'}.`);
  }
  const dependencyRoot = join(destination, 'dsh-dependencies');
  await mkdir(dependencyRoot, { recursive: true });
  await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/schemastery': '^3.18.1' } }));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-package-lock', '--legacy-peer-deps'], dependencyRoot);
  await mkdir(join(source, 'node_modules', '@deepseek-ai'), { recursive: true });
  await symlink(
    join(dependencyRoot, 'node_modules', '@deepseek-ai', 'schemastery'),
    join(source, 'node_modules', '@deepseek-ai', 'schemastery'),
    'junction',
  );
  return source;
}

try {
  run('pnpm', ['--filter', '@marshal/agent-runtime-host...', 'build']);
  run('pnpm', ['--filter', '@marshal/agent-runtime-dsh', 'build']);
  const packDir = join(temp, 'packs');
  await mkdir(packDir, { recursive: true });
  for (const name of packages) {
    run('pnpm', ['--filter', name, 'pack', '--pack-destination', packDir, '--silent']);
  }
  await mkdir(consumer, { recursive: true });
  const tarballs = await (await import('node:fs/promises')).readdir(packDir);
  const packageFiles = new Map(packages.map((name) => [
    name,
    `marshal-${name.slice('@marshal/'.length)}-0.1.0.tgz`,
  ]));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'g13-isolated-consumer',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(packages.map((name) => [
      name, `file:${join(packDir, packageFiles.get(name))}`,
    ])),
  }, null, 2));
  run('npm', ['install', '--offline', '--no-package-lock', '--ignore-scripts', ...tarballs.map((file) => join(packDir, file))], consumer);

  const requireFromConsumer = createRequire(join(consumer, 'package.json'));
  const importPackage = async (name) => import(pathToFileURL(requireFromConsumer.resolve(name)).href);
  const core = await importPackage('@marshal/agent-runtime-core');
  const composer = await importPackage('@marshal/agent-runtime-composer');
  const extensions = await importPackage('@marshal/agent-runtime-extensions');
  const dsh = await importPackage('@marshal/agent-runtime-dsh');
  pass('packed-install-and-public-api-imports');

  const packageRoot = join(temp, 'native-extension');
  await mkdir(packageRoot, { recursive: true });
  const entrypoint = [
    "const { createRuntimeServiceToken } = require('@marshal/agent-runtime-composer');",
    "const token = createRuntimeServiceToken('@g13/conformance:service');",
    "module.exports.activate = async (ctx) => ({",
    "  serviceContributions: [{ token, mode: 'many', binding: { useValue: { marker: ctx.configuration.marker } } }],",
    "  capabilityProviders: [{ id: 'g13.capability', version: '1', list: () => [{ protocolVersion: '1.0.0', name: 'g13.echo', version: '1', title: 'G13 echo', description: 'G13 echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: {}, additionalProperties: false } }], invoke: async (_name, input) => ({ output: input }) }],",
    "  eventSubscriptions: [{ type: '*', listener: () => { globalThis.__g13Event = true; } }],",
    "  catalogProviders: [{ id: 'g13.catalog', list: () => [{ id: 'g13.item', kind: 'resource', title: 'G13 item', description: 'G13 item', action: { type: 'resource_read', uri: 'g13://item' } }] }],",
    "  resourceProviders: [{ listResources: () => [{ uri: 'g13://item', name: 'G13 item', mimeType: 'text/plain' }], readResource: async () => ({ uri: 'g13://item', mimeType: 'text/plain', text: 'g13' }) }],",
    "  uiApplications: [{ id: 'g13.ui', title: 'G13 UI', description: 'G13 UI', renderId: 'g13.render', resource: { uri: 'g13://ui', mimeType: 'text/html', text: '<p>g13</p>' }, application: { version: '1.0.0', presentationModes: ['inline'], actions: [], tools: [], localState: { scope: 'project', schemaVersion: '1.0.0' }, authoritativeState: { capability: 'g13.echo', resourceId: 'g13', version: '1' } } }],",
    "});",
  ].join('\n');
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@g13/native-extension', version: '1.0.0', main: 'index.cjs', type: 'commonjs',
  }));
  await writeFile(join(packageRoot, 'index.cjs'), entrypoint);
  await writeFile(join(packageRoot, 'runtime-extension.json'), JSON.stringify({
    schemaVersion: 1, identity: '@g13/native-extension', version: '1.0.0',
    entrypoint: 'index.cjs', moduleFormat: 'commonjs-bundle-v1',
    configuration: { defaults: { marker: 'default' } },
    contributes: { services: ['g13.service'], capabilities: ['g13.echo'], events: ['*'], ui: ['g13.ui'], catalog: ['g13.item'] },
  }));
  const integrity = extensions.computeRuntimeExtensionIntegrity(packageRoot);
  const loader = new extensions.LocalRuntimeExtensionPackageLoader({
    allowedRoots: [temp],
    modules: { '@marshal/agent-runtime-composer': composer },
  });
  const kernel = core.createRuntimeKernel();
  const services = composer.createRuntimeServiceContainer();
  const manager = new extensions.RuntimeExtensionManager({
    kernel, loader, services,
    activationContext: { principal: { id: 'g13', kind: 'agent' }, scope: { workspaceId: 'g13-workspace' } },
  });
  const request = { packageRoot, integrity };
  const identity = '@g13/native-extension';

  await manager.install(request, { configuration: { marker: 'configured' } });
  if (!services.getAll(composer.createRuntimeServiceToken('@g13/conformance:service')).some((entry) => entry.marker === 'configured')) throw new Error('service contribution missing');
  if (!(await kernel.runtimeSearch({ protocolVersion: core.RUNTIME_PROTOCOL_VERSION, query: 'g13' }, { principal: { id: 'g13', kind: 'agent' }, scope: { workspaceId: 'g13-workspace' } })).matches?.some((x) => x.capability?.name === 'g13.echo')) throw new Error('capability contribution missing');
  pass('native-install-discovery-activation-contributions');
  await manager.configure(identity, { marker: 'reconfigured' });
  pass('native-configuration');
  await manager.disable(identity);
  await manager.enable(identity);
  pass('native-disable-enable');
  const replacementRoot = join(temp, 'native-replacement');
  await mkdir(replacementRoot, { recursive: true });
  await writeFile(join(replacementRoot, 'package.json'), JSON.stringify({ name: '@g13/native-extension', version: '2.0.0', main: 'index.cjs', type: 'commonjs' }));
  await writeFile(join(replacementRoot, 'index.cjs'), entrypoint.replace("'configured'", "'replacement'"));
  await writeFile(join(replacementRoot, 'runtime-extension.json'), JSON.stringify({ schemaVersion: 1, identity, version: '2.0.0', entrypoint: 'index.cjs', moduleFormat: 'commonjs-bundle-v1' }));
  await manager.update(identity, { packageRoot: replacementRoot, integrity: extensions.computeRuntimeExtensionIntegrity(replacementRoot) });
  pass('native-replacement');
  await manager.remove(identity);
  if (manager.get(identity)) throw new Error('uninstall did not remove extension');
  pass('native-uninstall');
  await manager.dispose();
  await services.shutdown();
  pass('native-service-capability-event-ui-catalog-cleanup');

  const dshRoot = await resolvePinnedDshPlugin(temp);
  if (!(await stat(join(dshRoot, 'lib', 'index.js'))).isFile()) throw new Error('Pinned DSH entrypoint is missing.');
  const loaded = dsh.loadDshPluginBridge(dshRoot);
  if (loaded.version !== '0.3.0' || !loaded.entrypoint.endsWith('lib/index.js')) throw new Error('Pinned DSH metadata mismatch.');
  const result = dsh.createDshRuntimeExtension({ apply: loaded.apply });
  const activation = await result.module.activate({ manifest: { schemaVersion: 1, identity: 'dsh', version: '0.3.0', entrypoint: 'index.js', moduleFormat: 'commonjs-bundle-v1' }, search: async () => ({ capabilities: [], catalog: [] }), execute: async () => ({ status: 'completed', output: null }) });
  if (!result.commands.list().some((command) => command.name === 'bridge')) throw new Error('real DSH plugin registered no bridge command');
  pass('dsh-pinned-plugin-command');
  if (typeof result.apiProxy.call !== 'function') throw new Error('DSH apiProxy contract is unavailable.');
  pass('dsh-pinned-plugin-api-proxy');
  await activation.dispose?.();
  if (result.commands.list().length !== 0) throw new Error('DSH event bridge cleanup did not remove command registrations');
  pass('dsh-pinned-plugin-event-bridge');
} catch (error) {
  fail('g13-harness-execution', error);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const required = [
  'packed-install-and-public-api-imports',
  'native-install-discovery-activation-contributions',
  'native-configuration',
  'native-disable-enable',
  'native-replacement',
  'native-uninstall',
  'native-service-capability-event-ui-catalog-cleanup',
  'dsh-pinned-plugin-command',
  'dsh-pinned-plugin-api-proxy',
  'dsh-pinned-plugin-event-bridge',
];
const failed = !required.every((name) => cases[name] === 'PASS');
console.log(JSON.stringify({ overall: failed ? 'FAIL' : 'PASS', cases }, null, 2));
if (failed) process.exitCode = 1;
