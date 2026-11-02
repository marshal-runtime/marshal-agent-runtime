#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configuredPackageManager } from './package-manager.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'marshal-installed-adaptive-'));
const deploymentRoot = options.deploymentRoot ?? path.join(temporaryRoot, 'installed');
const pluginRoot = path.join(temporaryRoot, 'plugin', 'marshal-runtime');
const workspacePath = path.join(temporaryRoot, 'blank-workspace');

try {
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
  ]);
  if (!options.deploymentRoot) await deployCandidate(deploymentRoot);

  const pluginCliPath = path.join(deploymentRoot, 'dist', 'pluginCli.js');
  const installed = spawnSync(process.execPath, [
    pluginCliPath,
    '--destination',
    pluginRoot,
    '--adaptive-agentic',
  ], {
    cwd: workspacePath,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) {
    throw new Error(`Adaptive plugin installation failed:\n${installed.stderr || installed.stdout}`);
  }
  const installResult = JSON.parse(installed.stdout);
  if (installResult.ok !== true || path.resolve(installResult.root) !== path.resolve(pluginRoot)) {
    throw new Error(`Adaptive plugin installer returned an unexpected result: ${installed.stdout}`);
  }

  const mcpPath = path.join(pluginRoot, '.mcp.json');
  const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
  const configuredServer = mcp.mcpServers?.['marshal-runtime'];
  assertInstalledAdaptiveProfile(configuredServer, deploymentRoot);

  await writeFile(
    path.join(workspacePath, 'AdaptiveInstalledApp.tsx'),
    `export default function AdaptiveInstalledApp() {
      return <main data-profile="adaptive-agentic"><h1>Installed adaptive UI</h1></main>;
    }`,
    'utf8',
  );

  const transport = new StdioClientTransport({
    command: configuredServer.command,
    args: configuredServer.args,
    cwd: workspacePath,
    env: runtimeEnvironment(configuredServer.env),
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'marshal-installed-adaptive-agentic-smoke',
    version: '1.0.0',
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'runtime_exec')) {
      throw new Error('Installed adaptive MCP server omitted runtime_exec.');
    }

    const compiled = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'ui.compile',
        input: {
          entryPath: 'AdaptiveInstalledApp.tsx',
          title: 'Installed adaptive UI',
        },
        context: { sessionId: 'installed-adaptive-agentic-smoke' },
      },
    });
    assertSuccessful(compiled, 'installed adaptive UI compilation');
    const componentId = compiled.structuredContent?.result?.output?.component?.id;
    const permission = compiled.structuredContent?.receipt?.permission;
    if (!/^[a-f0-9]{64}$/.test(componentId ?? '')) {
      throw new Error(`Installed adaptive UI compilation omitted its component ID: ${JSON.stringify(compiled.structuredContent)}`);
    }
    if (
      permission?.decision !== 'allow' ||
      JSON.stringify(permission.grants) !== JSON.stringify(['trusted_ui'])
    ) {
      throw new Error(`Installed adaptive UI compilation used unexpected authority: ${JSON.stringify(permission)}`);
    }

    const trustedNode = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'inline_module',
        executionMode: 'trusted_node',
        source: 'export default () => 42;',
        context: { sessionId: 'installed-adaptive-agentic-smoke' },
      },
    });
    if (trustedNode.structuredContent?.status !== 'denied') {
      throw new Error(`Installed adaptive profile unexpectedly allowed trusted Node: ${JSON.stringify(trustedNode.structuredContent)}`);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      distribution: '@marshal/agent-runtime-codex',
      deploymentRoot,
      suppliedReleaseCandidate: Boolean(options.deploymentRoot),
      installedProfile: configuredServer.env.MARSHAL_RUNTIME_PERMISSION_PROFILE,
      generatedAuthority: {
        packageWildcard: false,
        builtinWildcard: false,
        uiPackageWildcard: false,
      },
      pinnedInstalledLaunchVerified: true,
      brokeredUiCompile: {
        status: compiled.structuredContent?.status,
        permissionDecision: permission.decision,
        grants: permission.grants,
        componentId,
      },
      trustedNodeDenied: true,
      workspaceOutsideRepository: !isWithin(repositoryRoot, workspacePath),
    }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
} finally {
  assertTemporaryRoot(temporaryRoot);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function deployCandidate(target) {
  const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const packageManager = configuredPackageManager(rootManifest);
  const deployed = spawnSync(
    process.execPath,
    [
      packageManager.cli,
      '--filter',
      '@marshal/agent-runtime-codex',
      'deploy',
      target,
      '--prod',
      '--legacy',
    ],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (deployed.error) throw deployed.error;
  if (deployed.status !== 0) {
    throw new Error(`Detached package deployment failed:\n${deployed.stderr || deployed.stdout}`);
  }
}

function assertInstalledAdaptiveProfile(configuredServer, deploymentRoot) {
  if (!configuredServer || typeof configuredServer !== 'object') {
    throw new Error('Generated .mcp.json omitted the marshal-runtime server.');
  }
  const expectedEnvironment = {
    MARSHAL_RUNTIME_LIFECYCLE_TOOLS: 'hidden',
    MARSHAL_RUNTIME_PERMISSION_PROFILE: 'adaptive-agentic',
  };
  if (JSON.stringify(configuredServer.env) !== JSON.stringify(expectedEnvironment)) {
    throw new Error(`Generated adaptive authority was not exact: ${JSON.stringify(configuredServer.env)}`);
  }
  for (const authority of [
    'MARSHAL_RUNTIME_ALLOWED_PACKAGES',
    'MARSHAL_RUNTIME_ALLOWED_BUILTINS',
    'MARSHAL_RUNTIME_ALLOWED_UI_PACKAGES',
  ]) {
    if (authority in configuredServer.env || String(configuredServer.env[authority] ?? '').includes('*')) {
      throw new Error(`Generated adaptive profile included forbidden wildcard authority: ${authority}`);
    }
  }
  const expectedEntrypoint = path.resolve(deploymentRoot, 'dist', 'cli.js');
  if (
    path.resolve(configuredServer.command) !== path.resolve(process.execPath) ||
    !Array.isArray(configuredServer.args) ||
    configuredServer.args.length !== 1 ||
    path.resolve(configuredServer.args[0]) !== expectedEntrypoint
  ) {
    throw new Error(`Generated adaptive plugin did not pin the detached MCP launch: ${JSON.stringify(configuredServer)}`);
  }
  if (configuredServer.default_tools_approval_mode !== 'approve') {
    throw new Error('Generated adaptive plugin did not retain brokered tool approval.');
  }
}

function runtimeEnvironment(configuredEnvironment) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) =>
      typeof value === 'string' &&
      !name.toUpperCase().startsWith('MARSHAL_RUNTIME_') &&
      name !== 'AGENT_RUNTIME_KERNEL_MODULE' &&
      name !== 'AGENT_RUNTIME_WORKSPACE'),
  );
  return {
    ...inherited,
    ...configuredEnvironment,
  };
}

function assertSuccessful(result, label) {
  if (result.isError === true || result.structuredContent?.status !== 'success') {
    throw new Error(`${label} failed: ${JSON.stringify(result.structuredContent)}`);
  }
}

function parseArguments(arguments_) {
  let deploymentRoot;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    if (argument === '--deployment') {
      const value = arguments_[++index];
      if (!value || value.startsWith('--')) throw new Error('--deployment requires a directory.');
      deploymentRoot = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { deploymentRoot };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertTemporaryRoot(target) {
  if (
    path.dirname(path.resolve(target)) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('marshal-installed-adaptive-')
  ) {
    throw new Error(`Refusing to remove unexpected smoke root: ${target}`);
  }
}
