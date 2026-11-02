#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadRuntimeBindings } from './bindings.js';
import {
  createCodexAdapterDiagnostics,
  installCodexAdapterProcessDiagnostics,
  safeErrorIdentity,
  type CodexAdapterDiagnostics,
} from './diagnostics.js';
import { isDirectEntrypoint } from './entrypoint.js';
import { createCodexMcpServer } from './server.js';

interface CliOptions {
  kernelModule?: string;
  workspacePath?: string;
  help: boolean;
}

export async function runCodexMcpCli(
  argv = process.argv.slice(2),
  diagnostics?: CodexAdapterDiagnostics,
): Promise<void> {
  const cli = parseCliOptions(argv);
  if (cli.help) {
    process.stdout.write(usage());
    return;
  }

  const kernelModule =
    cli.kernelModule ?? process.env.AGENT_RUNTIME_KERNEL_MODULE ?? new URL('./index.js', import.meta.url).href;
  const workspacePath = cli.workspacePath ?? process.env.AGENT_RUNTIME_WORKSPACE ?? process.cwd();
  const bindings = await loadRuntimeBindings(kernelModule, { workspacePath });
  const server = createCodexMcpServer({
    ...bindings,
    defaultContext: { workspacePath },
    exposeLifecycleTools: process.env.MARSHAL_RUNTIME_LIFECYCLE_TOOLS !== 'hidden',
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  diagnostics?.record('server_ready');

  let shutdownOperation: Promise<void> | undefined;
  let sigtermCount = 0;
  const shutdown = (
    reason: 'sigint' | 'sigterm' | 'stdin_end',
    forceInterrupt: boolean,
  ): Promise<void> => {
    if (shutdownOperation) {
      if (forceInterrupt) {
        void Promise.resolve().then(() => bindings.dispose?.()).catch((error) => {
          diagnostics?.record('shutdown_failed', { reason, ...safeErrorIdentity(error) });
          process.exitCode = 1;
        });
      }
      return shutdownOperation;
    }
    shutdownOperation = (async () => {
      diagnostics?.record('shutdown_started', { reason });
      try {
        await bindings.dispose?.(
          forceInterrupt ? undefined : { drainBackgroundJobs: true },
        );
      } finally {
        await server.close();
      }
      diagnostics?.record('shutdown_complete', { reason });
    })();
    return shutdownOperation;
  };

  const requestShutdown = (reason: 'sigint' | 'sigterm' | 'stdin_end'): void => {
    const forceInterrupt =
      reason === 'sigint' || (reason === 'sigterm' && ++sigtermCount > 1);
    void shutdown(reason, forceInterrupt).catch((error) => {
      diagnostics?.record('shutdown_failed', { reason, ...safeErrorIdentity(error) });
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', () => requestShutdown('sigint'));
  process.on('SIGTERM', () => requestShutdown('sigterm'));
  process.stdin.once('end', () => requestShutdown('stdin_end'));
}

function parseCliOptions(argv: string[]): CliOptions {
  const result: CliOptions = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--kernel-module') {
      result.kernelModule = requiredValue(argv[++index], '--kernel-module');
      continue;
    }
    if (argument === '--workspace') {
      result.workspacePath = requiredValue(argv[++index], '--workspace');
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage(): string {
  return `agent-runtime-codex

Usage:
  agent-runtime-codex [--kernel-module <esm-module>] [--workspace <path>]

Environment:
  AGENT_RUNTIME_KERNEL_MODULE  Optional ESM module exporting runtime bindings
  AGENT_RUNTIME_WORKSPACE      Default workspace path for runtime calls
  MARSHAL_RUNTIME_LIFECYCLE_TOOLS  Set to hidden when native host hooks own lifecycle events
`;
}

if (isDirectEntrypoint(import.meta.url)) {
  const diagnostics = createCodexAdapterDiagnostics();
  diagnostics.record('process_start');
  installCodexAdapterProcessDiagnostics(diagnostics);
  runCodexMcpCli(process.argv.slice(2), diagnostics).catch((error) => {
    diagnostics.record('top_level_error', safeErrorIdentity(error));
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
