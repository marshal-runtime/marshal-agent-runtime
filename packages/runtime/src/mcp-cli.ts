#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentRuntimeHostOptions, RuntimeHostProviderSource } from '@marshal/agent-runtime-host';
import { createHash } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentRuntime, createRuntimeBuiltinsSource, createRuntimeHostMaterializer } from '@marshal/agent-runtime-host';
import { AGENT_WAKE_TASK_KIND, FileScheduleStore, RuntimeScheduleService } from './effects.js';
import { createRuntimeServiceContainer } from '@marshal/agent-runtime-composer';
import { RUNTIME_EXTENSION_LIFECYCLE_SERVICE } from './extensions.js';
import * as delegation from './delegation.js';
import { createRuntimeMcpServer } from './mcp.js';

/** Configuration comes exclusively from the launching host, never tool arguments. */
async function main(): Promise<void> {
  const value = JSON.parse(process.env.MARSHAL_RUNTIME_MCP_CONFIG ?? 'null') as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MARSHAL_RUNTIME_MCP_CONFIG must contain host configuration JSON.');
  }
  const allowed = new Set([
    'workspacePath', 'privateRoot', 'principalId', 'sessionId', 'harnessId',
    'permissionPatterns', 'codeIntelligence', 'extensions', 'bootstrapModule', 'hostOptions',
    'callerEmail', 'access', 'schedule',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Unknown host configuration field.');
  const required = (name: string): string => {
    const field = value[name];
    if (typeof field !== 'string' || !field.trim() || field.length > 4096) {
      throw new Error(`Host configuration requires ${name}.`);
    }
    return field;
  };
  const workspacePath = required('workspacePath');
  const principalId = required('principalId');
  const sessionId = required('sessionId');
  const harnessId = required('harnessId');
  const privateRoot = required('privateRoot');
  const callerEmail = value.callerEmail;
  if (callerEmail !== undefined && (typeof callerEmail !== 'string'
    || !/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,127}\.[a-z]{2,24}$/u.test(callerEmail))) {
    throw new Error('callerEmail must be a lower-case work email address chosen by the host.');
  }
  const accessLabel = /^(?:staff|brand:[a-z0-9][a-z0-9_-]{0,63}|user:[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,127}\.[a-z]{2,24}|group:[a-z0-9][a-z0-9_-]{0,63})$/u;
  const access = value.access;
  if (access !== undefined && (!Array.isArray(access) || access.length > 32
    || access.some((label) => typeof label !== 'string' || !accessLabel.test(label)))) {
    throw new Error('access must be a bounded list of staff, brand:<id>, user:<email> or group:<name> labels chosen by the host.');
  }
  const schedule = value.schedule as { rootDirectory?: unknown; taskKinds?: unknown } | undefined;
  if (schedule !== undefined && (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)
    || typeof schedule.rootDirectory !== 'string' || !isAbsolute(schedule.rootDirectory)
    || (schedule.taskKinds !== undefined && (!Array.isArray(schedule.taskKinds) || schedule.taskKinds.length > 32
      || schedule.taskKinds.some((kind) => typeof kind !== 'string' || !kind.trim()))))) {
    throw new Error('schedule must name a host-owned absolute rootDirectory and optional taskKinds.');
  }
  const permissionPatterns = value.permissionPatterns ?? [];
  if (!Array.isArray(permissionPatterns) || permissionPatterns.length > 256
    || permissionPatterns.some((pattern) => typeof pattern !== 'string' || !pattern.trim())) {
    throw new Error('permissionPatterns must be a bounded array of permission strings.');
  }
  if (value.codeIntelligence !== undefined && typeof value.codeIntelligence !== 'boolean') {
    throw new Error('codeIntelligence must be a boolean.');
  }
  const extensions = value.extensions ?? [];
  if (!Array.isArray(extensions) || extensions.length > 32 || extensions.some((item) =>
    !item || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).some((key) => !['packageRoot', 'configuration'].includes(key))
    || typeof item.packageRoot !== 'string' || !isAbsolute(item.packageRoot))) {
    throw new Error('extensions must be a bounded array of host-owned absolute package roots.');
  }
  let server: ReturnType<typeof createRuntimeMcpServer>;
  const bootstrap = value.bootstrapModule;
  if (bootstrap !== undefined && (typeof bootstrap !== 'string' || !isAbsolute(bootstrap))) {
    throw new Error('bootstrapModule must be a host-owned absolute module path.');
  }
  // The host chooses this module. Agents cannot load modules or change host configuration.
  const host = bootstrap === undefined ? {} : await (await import(pathToFileURL(bootstrap as string).href)).bootstrap({
    config: value,
    delegation,
    request: async (operation: string, input: unknown) => {
      const reply = await server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: JSON.stringify({ operation, input }) } }],
        maxTokens: 4096,
        _meta: { 'marshal.host-operation': true },
      });
      if (reply.content.type !== 'text') throw new Error('Host operation returned non-text content.');
      return JSON.parse(reply.content.text);
    },
  }) as {
    modules?: Record<string, unknown>;
    providerSources?: RuntimeHostProviderSource[];
    permissionApproval?: AgentRuntimeHostOptions['permissionApproval'];
    dispose?: () => Promise<void>;
  };
  let guidance = 'Marshal Runtime is available through runtime_search and runtime_exec. '
    + 'Search capabilities and inspect their schemas before calling them. You can execute TypeScript '
    + 'through the TypeScript capability using brokered Runtime calls. Permissions and execution receipts '
    + 'remain authoritative; do not bypass denied operations. For a capability use runtime_exec '
    + '{targetType: \"operation\", target: capabilityName, input: arguments}. For TypeScript use '
    + '{targetType: \"inline_module\", source, input}; export default async (input, context) => '
    + 'context.runtime.invoke(capabilityName, input) performs brokered calls. Examples using '
    + 'runtimeInvoke or runtimeSearch refer to the discovery/execution functions of their own host; '
    + 'this host exposes runtime_search and runtime_exec.';
  const owner = createHash('sha256').update(JSON.stringify([harnessId, principalId])).digest('hex');
  const runtime = await createAgentRuntime({
    workspacePath,
    protectedLifecycleResultRoot: privateRoot,
    stateDirectory: `.marshal/runtime/${owner}`,
    identity: { harnessId },
    principal: {
      id: principalId,
      kind: 'agent',
      ...(callerEmail === undefined && access === undefined
        ? {}
        : { claims: { ...(callerEmail === undefined ? {} : { callerEmail }), ...(access === undefined ? {} : { access }) } }),
    },
    permissionPatterns,
    permissionProfile: 'default',
    ...(host.permissionApproval ? { permissionApproval: host.permissionApproval } : {}),
    ...(value.codeIntelligence === false ? { codeIntelligence: false } : {}),
    extensions: extensions.length ? {
      allowedRoots: extensions.map((item) => item.packageRoot),
      discoveryRoots: extensions.map((item) => item.packageRoot),
      modules: host.modules,
      uiPlacementsRequired: false,
      restore: false,
    } : false,
    serviceContainer: createRuntimeServiceContainer(),
    providerSources: [
      ...(host.providerSources ?? []),
      () => ({ providers: [], catalog: {
        id: 'marshal.mcp.guidance',
        list: () => [{ id: 'runtime.agent-guidance', kind: 'skill' as const,
          title: 'Marshal Runtime capabilities', description: guidance,
          action: { type: 'host_tool' as const, toolId: 'runtime_search' },
        }],
      } }),
      createRuntimeBuiltinsSource({
      typescript: true, artifacts: true, effects: false, scheduling: schedule !== undefined,
      ...(schedule === undefined ? {} : {
        scheduler: new RuntimeScheduleService({
          store: new FileScheduleStore({ rootDirectory: schedule.rootDirectory as string }),
          acceptedTaskKinds: (schedule.taskKinds as string[] | undefined) ?? [AGENT_WAKE_TASK_KIND],
        }),
      }),
      reactUi: false, declarativeUi: false,
      extensionAuthoring: false, authoredUiPromotion: false,
    })],
  }).catch(async (error: unknown) => {
    await host.dispose?.();
    throw error;
  });
  try {
    for (const extension of extensions) {
      const materializer = await createRuntimeHostMaterializer({ allowedRoots: [extension.packageRoot] });
      const request = await materializer.materialize({ packageRoot: extension.packageRoot });
      const lifecycle = runtime.serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
      const installed = await lifecycle.install(request, {
        configuration: extension.configuration,
      });
      const record = lifecycle.get(installed.identity);
      if (record?.health !== 'healthy' || record.status !== 'enabled') {
        throw new Error(`Extension ${installed.identity} did not activate: ${JSON.stringify(record?.blockReasons)}`);
      }
    }
    const records = runtime.serviceContainer.tryGet(RUNTIME_EXTENSION_LIFECYCLE_SERVICE)?.list() ?? [];
    guidance += '\nInstalled extensions: ' + (records.map((record) => `${record.identity}@${record.version}`).join(', ') || 'none') + '.';
    for (const record of records) {
      if (record.status === 'enabled' && record.agentGuidance) {
        guidance += '\n' + JSON.stringify(record.agentGuidance);
      }
    }
  } catch (error) {
    try { await runtime.dispose(); } finally { await host.dispose?.(); }
    throw error;
  }
  server = createRuntimeMcpServer({ kernel: runtime.kernel, resources: runtime.resources, lifecycle: runtime.lifecycle, context: { sessionId, workspacePath } });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await server.close(); } finally {
      try { await runtime.dispose(); } finally { await host.dispose?.(); }
    }
  };
  server.onclose = () => { void close().catch(() => { process.exitCode = 1; }); };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  }
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Runtime MCP startup failed.'}\n`);
  process.exitCode = 1;
});
