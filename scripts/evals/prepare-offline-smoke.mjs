#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digestEffectiveCodexConfig, digestFixtureTree, readMarshalSecurityProfile } from './codex-driver.mjs';
import { sha256 } from './core.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARSHAL_PLUGIN_ID = 'marshal-runtime@personal';
const SAFETY_OVERRIDES = [
  'apps._default.enabled=false',
  'apps._default.open_world_enabled=false',
  'features.apps=false',
  'sandbox_workspace_write.network_access=false',
  'web_search="disabled"',
];
const SAFE_ENVIRONMENT_ALLOWLIST = [
  'APPDATA',
  'CODEX_HOME',
  'COMSPEC',
  'HOME',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
];

export async function prepareOfflineSmoke(outputDirectory, options = {}) {
  const root = options.repositoryRoot ?? REPOSITORY_ROOT;
  const output = resolve(outputDirectory);
  const codexBin = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const driverFile = join(root, 'scripts', 'evals', 'codex-driver.mjs');
  const confinementContractFile = join(root, 'scripts', 'evals', 'security', 'confinement-contract.mjs');
  const guardFile = join(root, 'scripts', 'evals', 'offline-network-guard.mjs');
  const objectiveOracleFile = join(root, 'scripts', 'evals', 'objective-oracle.mjs');
  const fixtureManifestFile = join(root, 'docs', 'evals', 'fixtures', 'offline-v1', 'manifest.json');
  const networkFixtureFile = join(root, 'docs', 'evals', 'fixtures', 'offline-v1', 'network-deny-all.json');
  const profile = JSON.parse(await readFile(join(root, 'docs', 'evals', 'offline-smoke.profile.json'), 'utf8'));
  if (profile.codexPackage !== '@openai/codex'
    || profile.allowModelInvocation !== false
    || profile.networkPolicy !== 'deny-all-agent-network') {
    throw new Error('The checked-in smoke profile must remain model-disabled with deny-all-agent-network policy.');
  }
  const fullCorpus = options.fullCorpus === true;
  if (fullCorpus && (typeof profile.fullCorpus?.runId !== 'string' || typeof profile.fullCorpus?.seed !== 'string')) {
    throw new Error('The checked-in smoke profile must declare stable fullCorpus runId and seed values.');
  }
  const marshalPluginId = options.marshalPluginId ?? profile.marshalPluginId ?? MARSHAL_PLUGIN_ID;
  await mkdir(output, { recursive: true });
  const probeCwd = join(output, 'config-probe-workspace');
  await mkdir(probeCwd, { recursive: true });

  const version = (await run(process.execPath, [codexBin, '--version'], root)).trim();
  const harnessVersion = version.match(/\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0];
  if (!harnessVersion) throw new Error(`Could not parse Codex version from: ${version}`);
  const inventory = JSON.parse(await run(process.execPath, [codexBin, 'plugin', 'list', '--json'], root));
  const installed = (inventory.installed ?? []).filter((item) => item.installed === true);
  const marshal = installed.find((item) => item.pluginId === marshalPluginId);
  if (!marshal?.source?.path) throw new Error(`Installed local plugin ${marshalPluginId} was not found.`);

  const installedPluginIds = installed.map((item) => item.pluginId).sort();
  const pluginStateOverrides = {
    disabled: pluginTableOverride(installedPluginIds, marshalPluginId, false),
    enabled: pluginTableOverride(installedPluginIds, marshalPluginId, true),
  };
  const discovered = await probeConfig(process.execPath, codexBin, probeCwd, pluginStateOverrides.disabled, SAFETY_OVERRIDES);
  const mcpIds = Object.keys(discovered.mcp_servers ?? {}).sort();
  const mcpDisables = mcpIds.length === 0 ? [] : [
    `mcp_servers={${mcpIds.map((id) => `"${escapeTomlKey(id)}"={command=${JSON.stringify(process.execPath)},args=[],enabled=false}`).join(',')}}`,
  ];
  const configOverrides = [...SAFETY_OVERRIDES, ...mcpDisables];
  const effective = await probeConfig(process.execPath, codexBin, probeCwd, pluginStateOverrides.disabled, configOverrides, {
    model: discovered.model,
    reasoning: discovered.model_reasoning_effort,
  });
  const enabledMcpServers = Object.entries(effective.mcp_servers ?? {}).filter(([, value]) => value?.enabled !== false);
  if (enabledMcpServers.length > 0) throw new Error(`Could not disable MCP servers: ${JSON.stringify(Object.fromEntries(enabledMcpServers))}`);

  const toolManifestFile = join(output, 'tool-manifest.json');
  const toolManifest = {
    schemaVersion: '1.0.0',
    codexCommandDriver: {
      commonEnabledPlugins: [],
      marshalPlugin: {
        id: marshalPluginId,
        version: marshal.version,
        sha256: await digestFixtureTree(marshal.source.path),
        securityProfile: await readMarshalSecurityProfile(marshal.source.path),
      },
      effectiveConfigWithoutMarshalSha256: digestEffectiveCodexConfig(effective, marshalPluginId),
    },
  };
  await writeJson(toolManifestFile, toolManifest);

  const [commit, dirty] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], root),
    run('git', ['status', '--porcelain'], root),
  ]);
  const configFile = join(output, 'run-config.json');
  const config = {
    schemaVersion: '1.0.0',
    runId: fullCorpus ? profile.fullCorpus.runId : profile.runId,
    corpus: join(root, 'docs', 'evals', 'v1'),
    output: join(output, 'evidence'),
    repetitions: profile.repetitions,
    seed: fullCorpus ? profile.fullCorpus.seed : profile.seed,
    adapter: {
      kind: 'command',
      command: process.execPath,
      args: [driverFile],
      cwd: root,
      driverFile,
      driverDigest: sha256(await readFile(driverFile)),
      driverDependencies: [await input(confinementContractFile)],
      driverOptions: {
        codexCommand: process.execPath,
        codexArgs: [codexBin],
        marshalPluginId,
        pluginStateOverrides,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        allowModelInvocation: profile.allowModelInvocation,
        environmentAllowlist: SAFE_ENVIRONMENT_ALLOWLIST,
        configOverrides,
        skipGitRepoCheck: true,
        networkFixtureGuard: {
          command: process.execPath,
          args: [guardFile],
          file: guardFile,
          sha256: sha256(await readFile(guardFile)),
        },
        objectiveOracle: {
          command: process.execPath,
          args: [objectiveOracleFile],
          file: objectiveOracleFile,
          sha256: sha256(await readFile(objectiveOracleFile)),
        },
      },
    },
    fixed: {
      harness: 'codex',
      harnessVersion,
      model: effective.model,
      reasoning: effective.model_reasoning_effort,
      repositoryCommit: commit.trim(),
      repositoryDirty: dirty.length > 0,
      os: `${process.platform}-${process.arch}`,
      maxRetries: 0,
      maxOutputBytes: 2 * 1024 * 1024,
    },
    inputs: {
      toolManifest: await input(toolManifestFile),
      fixtureManifest: await input(fixtureManifestFile),
      networkFixture: await input(networkFixtureFile),
    },
    selection: offlineSmokeSelection(profile, fullCorpus),
    redactions: [],
  };
  await writeJson(configFile, config);
  return { configFile, toolManifestFile, config };
}

export function offlineSmokeSelection(profile, fullCorpus) {
  if (!fullCorpus) return structuredClone(profile.selection);
  return profile.selection?.treatmentIds
    ? { treatmentIds: [...profile.selection.treatmentIds] }
    : undefined;
}

async function probeConfig(command, codexBin, cwd, pluginStateOverride, overrides, pins = {}) {
  const config = [
    ...(pins.model ? [`model=${JSON.stringify(pins.model)}`] : []),
    ...(pins.reasoning ? [`model_reasoning_effort=${JSON.stringify(pins.reasoning)}`] : []),
    'sandbox_mode="workspace-write"',
    'approval_policy="never"',
    pluginStateOverride,
    ...overrides,
  ];
  const args = [codexBin, 'app-server', '--stdio', '--strict-config', ...config.flatMap((value) => ['-c', value])];
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex config probe timed out.')); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 2) {
            clearTimeout(timer);
            child.kill();
            if (message.error) reject(new Error(message.error.message));
            else resolvePromise(message.result?.config ?? message.result);
            return;
          }
        } catch { /* wait for a complete JSONL line */ }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Codex config probe exited ${code}: ${stderr}`));
      }
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'marshal_offline_smoke', title: 'Marshal Offline Smoke', version: '1.0.0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'config/read', id: 2, params: { cwd, includeLayers: false } })}\n`);
  });
}

async function run(command, args, cwd) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

async function input(path) {
  return { path, sha256: sha256(await readFile(path)) };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function escapeTomlKey(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function pluginTableOverride(pluginIds, marshalPluginId, marshalEnabled) {
  const entries = pluginIds.map((id) => `"${escapeTomlKey(id)}"={enabled=${id === marshalPluginId && marshalEnabled ? 'true' : 'false'}}`);
  return `plugins={${entries.join(',')}}`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = process.argv.slice(2);
    const outputIndex = args.indexOf('--output');
    const fullCorpus = args.includes('--full-corpus');
    const unknown = args.filter((value, index) =>
      value !== '--full-corpus'
      && value !== '--help'
      && value !== '-h'
      && value !== '--output'
      && index !== outputIndex + 1);
    if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write('Usage: node scripts/evals/prepare-offline-smoke.mjs --output <directory> [--full-corpus]\n');
    } else if (outputIndex < 0 || !args[outputIndex + 1]) {
      throw new Error('--output <directory> is required.');
    } else {
      const result = await prepareOfflineSmoke(args[outputIndex + 1], { fullCorpus });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
