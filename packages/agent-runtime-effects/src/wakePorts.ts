import { spawn } from 'node:child_process';
import type { AgentWakeRequest, RuntimeWakePort } from './scheduler.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
const MAX_CAPTURED_STDERR_CHARACTERS = 2_000;
const HTTP_OK_FLOOR = 200;
const HTTP_OK_CEILING = 300;
const JSON_CONTENT_TYPE = 'application/json';

export const WAKE_ENV = {
  scheduleId: 'MARSHAL_WAKE_SCHEDULE_ID',
  fireId: 'MARSHAL_WAKE_FIRE_ID',
  sessionId: 'MARSHAL_WAKE_SESSION_ID',
  agentId: 'MARSHAL_WAKE_AGENT_ID',
  message: 'MARSHAL_WAKE_MESSAGE',
} as const;

export interface CommandWakePortOptions {
  /** Executable and fixed arguments chosen by the host; the agent supplies data only and no shell is involved. */
  readonly command: readonly [string, ...string[]];
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface HttpWakePortOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** The JSON body every wake port delivers. */
export function wakePayload(request: AgentWakeRequest): Record<string, unknown> {
  return {
    scheduleId: request.fire.scheduleId,
    fireId: request.fire.fireId,
    scheduledFor: request.fire.scheduledFor,
    attempt: request.fire.attempt,
    principalId: request.fire.principalId,
    ...(request.fire.scope ? { scope: request.fire.scope } : {}),
    target: request.target,
    message: request.message,
  };
}

/** Wakes an agent by running a host-chosen command with the wake as JSON on stdin and in `MARSHAL_WAKE_*` variables. */
export function createCommandWakePort(options: CommandWakePortOptions): RuntimeWakePort {
  const [executable, ...fixedArguments] = options.command;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return {
    wake: (request) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(executable, fixedArguments, {
          stdio: ['pipe', 'ignore', 'pipe'],
          env: {
            ...process.env,
            ...options.env,
            [WAKE_ENV.scheduleId]: request.fire.scheduleId,
            [WAKE_ENV.fireId]: request.fire.fireId,
            [WAKE_ENV.message]: request.message,
            [WAKE_ENV.sessionId]: request.target.sessionId ?? '',
            [WAKE_ENV.agentId]: request.target.agentId ?? '',
          },
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString('utf8')).slice(-MAX_CAPTURED_STDERR_CHARACTERS);
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Wake command exceeded ${timeoutMs} ms.`));
        }, timeoutMs);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Wake command exited ${code}: ${stderr.trim()}`));
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(JSON.stringify(wakePayload(request)));
      }),
  };
}

/** Wakes an agent by posting the wake as JSON to a host-chosen URL; any 2xx answer is success. */
export function createHttpWakePort(options: HttpWakePortOptions): RuntimeWakePort {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  return {
    wake: async (request) => {
      const response = await send(options.url, {
        method: 'POST',
        headers: { 'content-type': JSON_CONTENT_TYPE, ...options.headers },
        body: JSON.stringify(wakePayload(request)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status < HTTP_OK_FLOOR || response.status >= HTTP_OK_CEILING) {
        throw new Error(`Wake endpoint answered ${response.status}.`);
      }
    },
  };
}
