#!/usr/bin/env node
import type { Readable, Writable } from 'node:stream';
import { isDirectEntrypoint } from './entrypoint.js';
import {
  handleCodexHook,
  readEventName,
  rewriteMarshalPreToolUse,
  type CodexHookInput,
  type CodexHookOutput,
} from './hooks.js';
import { createCodexLifecycleRuntime } from './lifecycleRuntime.js';

export interface HookCliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export async function runCodexHookCli(
  io: HookCliIo = process,
  createRuntime = createCodexLifecycleRuntime,
): Promise<number> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    const source = await readStream(io.stdin);
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Codex hook stdin must contain one JSON object.');
    }
    const input = parsed as CodexHookInput;
    if (readEventName(input) === 'PreToolUse') {
      const output = rewriteMarshalPreToolUse(input);
      io.stdout.write(`${JSON.stringify(toCodexHookWireOutput(input, output))}\n`);
      return 0;
    }
    runtime = await createRuntime({ workspacePath: readWorkspacePath(input) });
    const output = await handleCodexHook(input, runtime.lifecycle, {
      transcriptSpool: runtime.transcriptSpool,
      sessionBriefing: runtime.sessionBriefing,
    });
    io.stdout.write(`${JSON.stringify(toCodexHookWireOutput(input, output))}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agent-runtime-codex-hook: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    io.stdout.write('{}\n');
    return 1;
  } finally {
    await runtime?.dispose();
  }
}

/** Codex accepts model-visible context only inside the event-specific wire envelope. */
function toCodexHookWireOutput(
  input: CodexHookInput,
  output: CodexHookOutput,
): Readonly<Record<string, unknown>> {
  if ('updatedInput' in output) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: output.updatedInput,
      },
    };
  }
  if ('denyReason' in output) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: output.denyReason,
      },
    };
  }
  if (!('additionalContext' in output) || !output.additionalContext.trim()) return {};
  return {
    hookSpecificOutput: {
      hookEventName: readEventName(input),
      additionalContext: output.additionalContext,
    },
  };
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (!value) throw new Error('Codex hook stdin was empty.');
  return value;
}

function readWorkspacePath(input: CodexHookInput): string | undefined {
  for (const key of ['cwd', 'workspace_path', 'workspacePath']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

if (isDirectEntrypoint(import.meta.url)) {
  const exitCode = await runCodexHookCli();
  process.exitCode = exitCode;
}
