#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import {
  AGENT_WAKE_TASK_KIND,
  FileScheduleStore,
  RuntimeScheduleService,
  createAgentWakeRunner,
  createCommandWakePort,
  createHttpWakePort,
  type RuntimeScheduleEvent,
  type RuntimeWakePort,
} from './effects.js';

const CONFIG_ENV = 'MARSHAL_RUNTIME_SCHEDULER_CONFIG';
const MAX_ARGUMENT_COUNT = 64;
const MAX_ARGUMENT_CHARACTERS = 4096;

/** Configuration comes exclusively from the launching host, never from an agent. */
function readConfig(): {
  rootDirectory: string;
  tickMs?: number;
  wake: RuntimeWakePort;
} {
  const value = JSON.parse(process.env[CONFIG_ENV] ?? 'null') as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${CONFIG_ENV} must contain host configuration JSON.`);
  }
  const allowed = new Set(['rootDirectory', 'tickMs', 'wake']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Unknown scheduler configuration field.');
  const rootDirectory = value.rootDirectory;
  if (typeof rootDirectory !== 'string' || !isAbsolute(rootDirectory)) {
    throw new Error('rootDirectory must be a host-owned absolute path.');
  }
  const tickMs = value.tickMs;
  if (tickMs !== undefined && (!Number.isSafeInteger(tickMs) || (tickMs as number) < 100)) {
    throw new Error('tickMs must be an integer of at least 100.');
  }
  return { rootDirectory, ...(tickMs === undefined ? {} : { tickMs: tickMs as number }), wake: readWake(value.wake) };
}

function readWake(value: unknown): RuntimeWakePort {
  const wake = value as { command?: unknown; http?: { url?: unknown; headers?: unknown } } | undefined;
  if (wake?.command !== undefined) {
    const command = wake.command;
    if (!Array.isArray(command) || command.length < 1 || command.length > MAX_ARGUMENT_COUNT
      || command.some((part) => typeof part !== 'string' || !part || part.length > MAX_ARGUMENT_CHARACTERS)) {
      throw new Error('wake.command must be a bounded array of strings.');
    }
    return createCommandWakePort({ command: command as [string, ...string[]] });
  }
  if (wake?.http !== undefined) {
    if (typeof wake.http.url !== 'string' || !/^https?:\/\//u.test(wake.http.url)) {
      throw new Error('wake.http.url must be an http(s) URL.');
    }
    return createHttpWakePort({ url: wake.http.url, headers: wake.http.headers as Record<string, string> | undefined });
  }
  throw new Error('wake must name a command or an http endpoint.');
}

const log = (event: RuntimeScheduleEvent): void => {
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event: event.type,
    scheduleId: event.fire.scheduleId,
    fireId: event.fire.fireId,
    attempt: event.fire.attempt,
    ...('error' in event ? { error: event.error } : {}),
  })}\n`);
};

async function main(): Promise<void> {
  const config = readConfig();
  const service = new RuntimeScheduleService({
    store: new FileScheduleStore({ rootDirectory: config.rootDirectory }),
    runners: { [AGENT_WAKE_TASK_KIND]: createAgentWakeRunner(config.wake) },
    ...(config.tickMs === undefined ? {} : { tickMs: config.tickMs }),
    onEvent: log,
  });
  service.start();
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'started', rootDirectory: config.rootDirectory })}\n`);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void service.stop().then(() => process.exit(0), () => process.exit(1)); });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Runtime scheduler startup failed.'}\n`);
  process.exitCode = 1;
});
