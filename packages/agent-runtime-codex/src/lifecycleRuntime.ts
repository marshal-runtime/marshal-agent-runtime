import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  createRuntimeLifecycleAuthority,
  type RuntimeLifecycleAuthority,
} from '@marshal/agent-runtime-host';
import {
  createRuntimeSessionBriefing,
  type RuntimeSessionBriefingOptions,
} from '@marshal/agent-runtime-host/session-briefing';
import {
  resolveCodexHarnessIdentity,
  type CodexHarnessIdentity,
} from './identity.js';
import {
  codexAdapterDiagnosticRoot,
  codexProtectedLifecycleResultRoot,
  codexTranscriptSpoolRoot,
} from './runtimePaths.js';
import type { RuntimeLifecyclePort } from './ports.js';
import { TranscriptSpool } from './transcriptSpool.js';

export interface CodexLifecycleRuntimeOptions {
  readonly workspacePath?: string;
  readonly stateDirectory?: string;
  readonly protectedLifecycleResultRoot?: string;
  readonly identity?: Parameters<typeof resolveCodexHarnessIdentity>[0];
  readonly transcriptSpoolRoot?: string;
  readonly sessionBriefingOptions?: RuntimeSessionBriefingOptions;
}

export interface CodexLifecycleRuntimeBindings {
  readonly lifecycle: RuntimeLifecyclePort;
  readonly identity: CodexHarnessIdentity;
  readonly transcriptSpool: TranscriptSpool;
  readonly sessionBriefing: string;
  dispose(): Promise<void>;
}

/** Generic Codex hook composition; domain lifecycle delegates are installed by extensions. */
export function createCodexLifecycleRuntime(
  options: CodexLifecycleRuntimeOptions = {},
): CodexLifecycleRuntimeBindings {
  const identity = resolveCodexHarnessIdentity(options.identity);
  const stateDirectory = path.resolve(options.stateDirectory ?? codexAdapterDiagnosticRoot());
  const protectedRoot = path.resolve(
    options.protectedLifecycleResultRoot ?? codexProtectedLifecycleResultRoot(),
  );
  const authority: RuntimeLifecycleAuthority = createRuntimeLifecycleAuthority(
    stateDirectory,
    [],
    protectedRoot,
  );
  const transcriptSpool = new TranscriptSpool({
    rootDirectory: options.transcriptSpoolRoot ?? codexTranscriptSpoolRoot(),
    deliveryTargetIdentity: createHash('sha256')
      .update(stateDirectory.toLowerCase())
      .digest('hex'),
  });
  const sessionBriefing = createRuntimeSessionBriefing(options.sessionBriefingOptions);
  return {
    lifecycle: authority,
    identity,
    transcriptSpool,
    sessionBriefing,
    async dispose() {},
  };
}
