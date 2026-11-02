#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_OVERRIDES = [
  'apps._default.enabled=false',
  'apps._default.open_world_enabled=false',
  'features.apps=false',
  'sandbox_workspace_write.network_access=false',
  'web_search="disabled"',
];

export async function attestOfflineNetworkPolicy(request) {
  assert(request?.schemaVersion === '1.0.0', 'Expected guard request schemaVersion 1.0.0.');
  assert(typeof request.fixturePath === 'string', 'fixturePath is required.');
  assert(/^[a-f0-9]{64}$/.test(request.fixtureSha256 ?? ''), 'fixtureSha256 is invalid.');
  const fixtureBytes = await readFile(resolve(request.fixturePath));
  assert(sha256(fixtureBytes) === request.fixtureSha256, 'Network fixture bytes do not match the pinned digest.');
  const fixture = JSON.parse(fixtureBytes.toString('utf8'));
  assert(canonicalJson(fixture) === canonicalJson(request.fixture), 'Inline network fixture differs from the pinned file.');
  assert(fixture.schemaVersion === '1.0.0' && fixture.mode === 'deny-all-agent-network', 'Only deny-all-agent-network fixtures are accepted.');
  assert(fixture.policy?.webSearch === 'disabled', 'The fixture must disable web search.');
  assert(fixture.policy?.sandboxNetworkAccess === false, 'The fixture must disable sandbox network access.');
  assert(fixture.policy?.appsEnabled === false, 'The fixture must disable app connectors.');
  assert(Array.isArray(fixture.policy?.externalMcpServers) && fixture.policy.externalMcpServers.length === 0, 'The fixture must allow no external MCP servers.');

  const enforcement = request.enforcement;
  assert(enforcement?.sandbox === 'workspace-write', 'Offline evaluation requires the workspace-write sandbox.');
  assert(enforcement?.approvalPolicy === 'never', 'Offline evaluation requires approval_policy=never.');
  assert(Array.isArray(enforcement.configOverrides), 'Exact config overrides are required.');
  for (const override of REQUIRED_OVERRIDES) {
    assert(enforcement.configOverrides.includes(override), `Missing required Codex override: ${override}`);
  }
  assert(Array.isArray(enforcement.commonEnabledPlugins) && enforcement.commonEnabledPlugins.length === 0, 'Offline evaluation permits no common plugins; only the isolated Marshal treatment plugin may vary.');

  const config = enforcement.effectiveConfig;
  assert(config?.sandbox_mode === 'workspace-write', 'Effective sandbox_mode is not workspace-write.');
  assert(config?.approval_policy === 'never', 'Effective approval_policy is not never.');
  assert(config?.web_search === 'disabled', 'Effective web_search is not disabled.');
  assert(config?.sandbox_workspace_write?.network_access === false, 'Effective sandbox network access is not disabled.');
  assert(config?.features?.apps === false, 'Effective app feature is not disabled.');
  assert(config?.apps?._default?.enabled === false, 'Effective default app state is not disabled.');
  assert(config?.apps?._default?.open_world_enabled === false, 'Effective open-world app tools are not disabled.');
  const enabledMcpServers = Object.entries(config?.mcp_servers ?? {})
    .filter(([, value]) => value?.enabled !== false)
    .map(([id]) => id);
  assert(enabledMcpServers.length === 0, `Enabled user MCP servers are forbidden: ${enabledMcpServers.join(', ')}.`);

  const enforcementSha256 = sha256(canonicalJson({
    approvalPolicy: enforcement.approvalPolicy,
    commonEnabledPlugins: enforcement.commonEnabledPlugins,
    configOverrides: enforcement.configOverrides,
    effectiveNetworkConfig: {
      apps: config.apps,
      features: { apps: config.features.apps },
      mcp_servers: config.mcp_servers ?? {},
      sandbox_mode: config.sandbox_mode,
      sandbox_workspace_write: config.sandbox_workspace_write,
      web_search: config.web_search,
    },
    sandbox: enforcement.sandbox,
  }));
  return {
    ok: true,
    mode: fixture.mode,
    fixtureSha256: request.fixtureSha256,
    enforcementSha256,
    guarantees: [
      'web-search-disabled',
      'apps-disabled',
      'sandbox-network-disabled',
      'user-mcp-servers-disabled',
      'no-common-plugins',
    ],
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = await attestOfflineNetworkPolicy(JSON.parse(await readStdin()));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
