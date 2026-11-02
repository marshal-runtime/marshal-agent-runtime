import { createHash } from 'node:crypto';
import { createRuntimeSessionBriefing } from '@marshal/agent-runtime-host/session-briefing';
import { projectPromptRoutingHint } from '@marshal/agent-runtime-manifest';
import type { RuntimeLifecyclePort } from './ports.js';
import {
  TranscriptSpool,
  type SealedTranscriptDescriptor,
  type TranscriptEpochReference,
  type TranscriptReviewDescriptor,
} from './transcriptSpool.js';

const CODEX_RUNTIME_ENTRY_POINTS = {
  discoveryEntryPoint: 'runtime_search',
  executionEntryPoint: 'runtime_exec',
  renderComponentEntryPoint: 'runtime_render_component',
} as const;
const CODEX_RUNTIME_SESSION_BRIEFING = createRuntimeSessionBriefing(CODEX_RUNTIME_ENTRY_POINTS);
const CODEX_RUNTIME_BOOTSTRAP_METADATA = {
  hookEventName: 'SessionStart',
} as const;

export type CodexHookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop';

export type CodexHookOutput =
  | Readonly<{ additionalContext: string }>
  | Readonly<{ updatedInput: Readonly<Record<string, unknown>> }>
  | Readonly<{ denyReason: string }>
  | Readonly<Record<string, never>>;

export interface CodexHookInput extends Record<string, unknown> {
  hook_event_name?: string;
  hookEventName?: string;
  eventName?: string;
  event?: string;
}

export interface CodexHookOptions {
  readonly transcriptSpool?: TranscriptSpool;
  readonly sessionBriefing?: string;
}

export async function handleCodexHook(
  input: CodexHookInput,
  lifecycle: RuntimeLifecyclePort,
  options: CodexHookOptions = {},
): Promise<CodexHookOutput> {
  const eventName = readEventName(input);
  const sessionId =
    readString(input, ['session_id', 'sessionId', 'thread_id', 'threadId']) ?? 'codex-default';
  const agentId = readString(input, ['agent_id', 'agentId']);
  const workspacePath = readString(input, ['cwd', 'workspace_path', 'workspacePath']);
  const metadata = hookMetadata(input, eventName);
  const protocolVersion = normalizeProtocolVersion(
    readString(input, ['protocol_version', 'protocolVersion']),
  );
  const baseEventId = stableHookEventId(input, eventName, sessionId);

  switch (eventName) {
    case 'SessionStart': {
      const result = await ensureSession(lifecycle, {
        protocolVersion,
        eventId: `${baseEventId}:session-start`,
        sessionId,
        agentId,
        workspacePath,
        metadata,
      });
      if (options.transcriptSpool) {
        const source = readString(input, ['source']);
        if (source === 'compact') {
          await options.transcriptSpool.appendCompactionSegment({
            eventId: `${baseEventId}:compaction`,
            sessionId,
            segmentId: `segment-${digest(`${sessionId}:${baseEventId}`)}`,
            summary: readString(input, [
              'compaction_summary',
              'compactionSummary',
              'summary',
            ]) ?? 'Codex reported a context compaction boundary.',
            metadata,
          });
        } else {
          await options.transcriptSpool.startSession({
            eventId: `${baseEventId}:session-start`,
            sessionId,
            agentId,
            workspacePath,
            metadata,
          });
        }
      }
      return {
        additionalContext: joinContexts(
          options.sessionBriefing ?? CODEX_RUNTIME_SESSION_BRIEFING,
          extractAdditionalContext(result),
        ),
      };
    }
    case 'UserPromptSubmit': {
      const prompt = readFirst(input, ['prompt', 'user_prompt', 'userPrompt', 'message']) ?? '';
      const started = await ensureSession(lifecycle, {
        protocolVersion,
        eventId: bootstrapEventId(sessionId),
        sessionId,
        agentId,
        workspacePath,
        metadata: CODEX_RUNTIME_BOOTSTRAP_METADATA,
      });
      const result = options.transcriptSpool
        ? await options.transcriptSpool.append({
            eventId: `${baseEventId}:user-message`,
            sessionId,
            kind: 'user_message',
            content: prompt,
            agentId,
            workspacePath,
            metadata,
          })
        : await lifecycle.observeTurn({
            protocolVersion,
            eventId: `${baseEventId}:user-message`,
            sessionId,
            kind: 'user_message',
            content: prompt,
            agentId,
            workspacePath,
            metadata,
          });
      return {
        additionalContext: joinContexts(
          typeof prompt === 'string'
            ? projectPromptRoutingHint(prompt, {
                discovery: CODEX_RUNTIME_ENTRY_POINTS.discoveryEntryPoint,
                execution: CODEX_RUNTIME_ENTRY_POINTS.executionEntryPoint,
                renderComponent: CODEX_RUNTIME_ENTRY_POINTS.renderComponentEntryPoint,
              })
            : undefined,
          extractAdditionalContext(started),
          extractAdditionalContext(result),
        ),
      };
    }
    case 'PreToolUse':
      return rewriteMarshalPreToolUse(input);
    case 'PostToolUse':
      await ensureSession(lifecycle, {
        protocolVersion,
        eventId: bootstrapEventId(sessionId),
        sessionId,
        agentId,
        workspacePath,
        metadata: CODEX_RUNTIME_BOOTSTRAP_METADATA,
      });
      const toolContent =
        readFirst(input, [
          'tool_response',
          'toolResponse',
          'tool_result',
          'toolResult',
          'result',
        ]) ?? null;
      if (options.transcriptSpool) {
        await options.transcriptSpool.append({
          eventId: `${baseEventId}:tool-result`,
          sessionId,
          kind: 'tool_result',
          content: toolContent,
          toolName: readString(input, ['tool_name', 'toolName']),
          agentId,
          workspacePath,
          metadata,
        });
      } else {
        await lifecycle.observeTurn({
          protocolVersion,
          eventId: `${baseEventId}:tool-result`,
          sessionId,
          kind: 'tool_result',
          content: toolContent,
          toolName: readString(input, ['tool_name', 'toolName']),
          agentId,
          workspacePath,
          metadata,
        });
      }
      return {};
    case 'Stop':
      await ensureSession(lifecycle, {
        protocolVersion,
        eventId: bootstrapEventId(sessionId),
        sessionId,
        agentId,
        workspacePath,
        metadata: CODEX_RUNTIME_BOOTSTRAP_METADATA,
      });
      const assistantContent =
        readFirst(input, [
          'last_assistant_message',
          'lastAssistantMessage',
          'assistant_message',
          'assistantMessage',
          'response',
        ]) ?? '';
      if (options.transcriptSpool) {
        const checkpoint = await options.transcriptSpool.append({
          eventId: `${baseEventId}:assistant-turn`,
          sessionId,
          kind: 'assistant_turn',
          content: assistantContent,
          agentId,
          workspacePath,
          metadata,
        });
        await deliverTranscript(
          options.transcriptSpool,
          { sessionId, epochId: checkpoint.epochId },
          lifecycle,
          protocolVersion,
        );
      } else {
        await lifecycle.observeTurn({
          protocolVersion,
          eventId: `${baseEventId}:assistant-turn`,
          sessionId,
          kind: 'assistant_turn',
          content: assistantContent,
          agentId,
          workspacePath,
          metadata,
        });
      }
      return {};
    case 'SessionEnd':
      await ensureSession(lifecycle, {
        protocolVersion,
        eventId: bootstrapEventId(sessionId),
        sessionId,
        agentId,
        workspacePath,
        metadata: CODEX_RUNTIME_BOOTSTRAP_METADATA,
      });
      let transcriptReview: TranscriptReviewDescriptor | undefined;
      if (options.transcriptSpool) {
        const terminalCheckpoint = await checkpointTranscriptEnd(
          options.transcriptSpool,
          sessionId,
          `${baseEventId}:session-end`,
          input,
          agentId,
          workspacePath,
        );
        await deliverTranscript(
          options.transcriptSpool,
          terminalCheckpoint,
          lifecycle,
          protocolVersion,
        );
        transcriptReview = 'kind' in terminalCheckpoint
          ? terminalCheckpoint
          : await options.transcriptSpool.seal(sessionId);
      }
      await lifecycle.endSession({
        protocolVersion,
        eventId: `${baseEventId}:session-end`,
        sessionId,
        outcome: readString(input, ['outcome', 'reason']),
        metadata: transcriptReview ? { ...metadata, transcriptReview } : metadata,
      });
      return {};
    case 'SubagentStart': {
      const childSessionId =
        readString(input, ['subagent_id', 'subagentId', 'child_session_id', 'childSessionId']) ??
        `${sessionId}:subagent`;
      const parentEpochId = options.transcriptSpool
        ? await options.transcriptSpool.openEpochId(sessionId)
        : undefined;
      const result = await ensureSession(lifecycle, {
        protocolVersion,
        eventId: `${baseEventId}:subagent-start`,
        sessionId: childSessionId,
        parentSessionId: sessionId,
        agentId: readString(input, ['subagent_id', 'subagentId', 'agent_id', 'agentId']),
        workspacePath,
        metadata: { ...metadata, parentSessionId: sessionId },
      });
      if (options.transcriptSpool) {
        await options.transcriptSpool.append({
          eventId: `${baseEventId}:parent-subagent-start`,
          sessionId,
          kind: 'subagent_start',
          content: { childSessionId },
          agentId,
          workspacePath,
          metadata: {
            childSessionId,
            ...(parentEpochId ? { parentEpochId } : {}),
          },
        });
        await options.transcriptSpool.append({
          eventId: `${baseEventId}:subagent-start`,
          sessionId: childSessionId,
          kind: 'subagent_start',
          agentId: readString(input, ['subagent_id', 'subagentId', 'agent_id', 'agentId']),
          workspacePath,
          metadata,
          parentSessionId: sessionId,
          parentEpochId,
        });
      }
      return {
        additionalContext: joinContexts(
          options.sessionBriefing ?? CODEX_RUNTIME_SESSION_BRIEFING,
          extractAdditionalContext(result),
        ),
      };
    }
    case 'SubagentStop': {
      const childSessionId =
        readString(input, ['subagent_id', 'subagentId', 'child_session_id', 'childSessionId']) ??
        `${sessionId}:subagent`;
      const parentEpochId = options.transcriptSpool
        ? await options.transcriptSpool.openEpochId(sessionId)
        : undefined;
      await ensureSession(lifecycle, {
        protocolVersion,
        eventId: bootstrapEventId(childSessionId),
        sessionId: childSessionId,
        parentSessionId: sessionId,
        agentId: readString(input, ['subagent_id', 'subagentId', 'agent_id', 'agentId']),
        workspacePath,
        metadata: { ...metadata, parentSessionId: sessionId },
      });
      const childMetadata = { ...metadata, parentSessionId: sessionId };
      if (options.transcriptSpool) {
        await options.transcriptSpool.append({
          eventId: `${baseEventId}:subagent-end`,
          sessionId: childSessionId,
          kind: 'subagent_end',
          content: readString(input, ['outcome', 'reason']),
          agentId: readString(input, ['subagent_id', 'subagentId', 'agent_id', 'agentId']),
          workspacePath,
          metadata,
          parentSessionId: sessionId,
          parentEpochId,
        });
      }
      const childTranscriptReview = options.transcriptSpool
        ? await options.transcriptSpool.seal(childSessionId)
        : undefined;
      if (options.transcriptSpool && childTranscriptReview) {
        await deliverTranscript(
          options.transcriptSpool,
          childTranscriptReview,
          lifecycle,
          protocolVersion,
        );
      }
      await lifecycle.endSession({
        protocolVersion,
        eventId: `${baseEventId}:subagent-end`,
        sessionId: childSessionId,
        parentSessionId: sessionId,
        outcome: readString(input, ['outcome', 'reason']),
        metadata: childTranscriptReview
          ? { ...childMetadata, transcriptReview: childTranscriptReview }
          : childMetadata,
      });
      if (options.transcriptSpool && childTranscriptReview) {
        const outcome = readString(input, ['outcome', 'reason']);
        const conclusionReference = readString(input, ['conclusion', 'summary', 'result']);
        await options.transcriptSpool.append({
          eventId: `${baseEventId}:parent-subagent-end`,
          sessionId,
          kind: 'subagent_end',
          content: {
            childSessionId,
            childEpochId: childTranscriptReview.epochId,
            descriptorId: childTranscriptReview.descriptorId,
            idempotencyKey: childTranscriptReview.idempotencyKey,
            sha256: childTranscriptReview.sha256,
            eventCount: childTranscriptReview.eventCount,
            ...(outcome ? { outcome } : {}),
            ...(conclusionReference ? { conclusionReference } : {}),
          },
          agentId,
          workspacePath,
          metadata: {
            childSessionId,
            childEpochId: childTranscriptReview.epochId,
            childDescriptorId: childTranscriptReview.descriptorId,
          },
        });
      }
      return {};
    }

  }
}

async function deliverTranscript(
  spool: TranscriptSpool,
  source: TranscriptEpochReference | SealedTranscriptDescriptor,
  lifecycle: RuntimeLifecyclePort,
  protocolVersion: string,
): Promise<void> {
  await spool.deliverUndelivered(source, async (observation) => {
    const result = await lifecycle.observeTurn({ protocolVersion, ...observation });
    const failed = readLifecycleDiagnostics(result).find(
      (diagnostic) => diagnostic.code === 'lifecycle_delegate_failed',
    );
    if (failed) {
      throw new Error(`Lifecycle transcript delivery failed: ${failed.message ?? failed.code}`);
    }
  });
}

function readLifecycleDiagnostics(
  result: unknown,
): readonly Readonly<{ code?: unknown; message?: unknown }>[] {
  if (!result || typeof result !== 'object' || !('diagnostics' in result)) return [];
  const diagnostics = result.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.filter(
    (diagnostic): diagnostic is Readonly<{ code?: unknown; message?: unknown }> =>
      Boolean(diagnostic) && typeof diagnostic === 'object',
  );
}

async function checkpointTranscriptEnd(
  spool: TranscriptSpool,
  sessionId: string,
  eventId: string,
  input: CodexHookInput,
  agentId: string | undefined,
  workspacePath: string | undefined,
): Promise<TranscriptEpochReference | TranscriptReviewDescriptor> {
  return spool.checkpointWithEvent({
    eventId,
    sessionId,
    kind: 'session_end',
    content: readString(input, ['outcome', 'reason']),
    agentId,
    workspacePath,
    metadata: hookMetadata(input, 'SessionEnd'),
  });
}

async function ensureSession(
  lifecycle: RuntimeLifecyclePort,
  request: Parameters<RuntimeLifecyclePort['startSession']>[0],
): Promise<unknown> {
  try {
    return await lifecycle.startSession(request);
  } catch (error) {
    if (error instanceof Error && /already started/i.test(error.message)) return undefined;
    throw error;
  }
}

function extractAdditionalContext(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const context = (value as Record<string, unknown>).additionalContext;
  return typeof context === 'string' && context.trim() ? context : undefined;
}

function joinContexts(...values: Array<string | undefined>): string {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].join('\n\n');
}

export function readEventName(input: CodexHookInput): CodexHookEventName {
  const value = readString(input, ['hook_event_name', 'hookEventName', 'eventName', 'event']);
  if (
    value === 'SessionStart' ||
    value === 'UserPromptSubmit' ||
    value === 'PreToolUse' ||
    value === 'PostToolUse' ||
    value === 'Stop' ||
    value === 'SessionEnd' ||
    value === 'SubagentStart' ||
    value === 'SubagentStop'
  ) {
    return value;
  }
  throw new Error(`Unsupported Codex hook event: ${value ?? '<missing>'}.`);
}

/**
 * Attach Codex-provided task and tool-use claims to the pending Marshal call.
 * The MCP server treats these as untrusted correlation only and generates its
 * own invocation identity.
 * This is intentionally pure so the hook CLI can run it without constructing
 * the lifecycle runtime or starting a provider.
 */
export function rewriteMarshalPreToolUse(input: CodexHookInput): CodexHookOutput {
  const toolName = readString(input, ['tool_name', 'toolName']);
  if (!toolName || !/^mcp__marshal[-_]runtime__/.test(toolName)) return {};

  const toolInput = readObject(input, ['tool_input', 'toolInput']);
  if (!toolInput) return { denyReason: 'Marshal tool input must be a JSON object.' };

  const sessionId = readString(input, ['session_id', 'sessionId']);
  const workspacePath = readString(input, ['cwd', 'workspace_path', 'workspacePath']);
  if (!sessionId || !workspacePath) {
    return {
      denyReason: 'Codex did not provide the session and workspace claims required by Marshal.',
    };
  }

  const threadId =
    readString(input, ['thread_id', 'threadId']) ?? sessionId;
  const agentId = readString(input, ['agent_id', 'agentId']);
  const turnId = readString(input, ['turn_id', 'turnId']);
  const toolUseId =
    readString(input, ['tool_use_id', 'toolUseId']) ??
    `codex-call-${digest(stableJson({ sessionId, threadId, turnId, toolName, toolInput }))}`;
  const suppliedContext = readObject(toolInput, ['context']);
  const suppliedMetadata = suppliedContext
    ? readObject(suppliedContext, ['metadata'])
    : undefined;
  const callerMetadata = sanitizePreToolMetadata(suppliedMetadata);

  return {
    updatedInput: {
      ...toolInput,
      context: {
        sessionId,
        threadId,
        ...(agentId ? { agentId } : {}),
        workspacePath,
        metadata: {
          ...callerMetadata,
          codexPreToolClaim: {
            sessionId,
            threadId,
            ...(agentId ? { agentId } : {}),
            workspacePath,
            ...(turnId ? { turnId } : {}),
            toolUseId,
          },
        },
      },
    },
  };
}

function hookMetadata(
  input: CodexHookInput,
  eventName: CodexHookEventName,
): Record<string, unknown> {
  return {
    hookEventName: eventName,
    source: readString(input, ['source']),
    transcriptPath: readString(input, ['transcript_path', 'transcriptPath']),
    toolUseId: readString(input, ['tool_use_id', 'toolUseId']),
    turnIndex: readFirst(input, ['turn_index', 'turnIndex']),
  };
}

function readFirst(input: CodexHookInput, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined) return input[key];
  }
  return undefined;
}

function readObject(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const value = readFirst(input, keys);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readString(input: CodexHookInput, keys: readonly string[]): string | undefined {
  const value = readFirst(input, keys);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (value.length > 4_096) {
    throw new Error(`${keys[0] ?? 'Codex hook string'} must be at most 4096 characters`);
  }
  return value;
}

function sanitizePreToolMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      key !== 'source' &&
      key !== 'mcpRequestId' &&
      key !== 'codexSessionId' &&
      key !== 'codexThreadId' &&
      key !== 'codexTurnId' &&
      key !== 'codexToolUseId' &&
      key !== 'codexPreToolClaim'
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function stableHookEventId(
  input: CodexHookInput,
  eventName: CodexHookEventName,
  sessionId: string,
): string {
  const supplied = readString(input, [
    'event_id',
    'eventId',
    'request_id',
    'requestId',
    'tool_use_id',
    'toolUseId',
  ]);
  return `codex-${digest(stableJson({ eventName, sessionId, supplied, input }))}`;
}

function bootstrapEventId(sessionId: string): string {
  return `codex-bootstrap-${digest(sessionId)}`;
}

function normalizeProtocolVersion(value: string | undefined): string {
  const version = value ?? '1.0.0';
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match || Number(match[1]) !== 1) {
    throw new Error(`Unsupported Codex lifecycle protocol version: ${version}`);
  }
  return version;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
