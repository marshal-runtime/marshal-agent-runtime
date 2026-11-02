#!/usr/bin/env node
import { runCodexMcpCli } from '@marshal/agent-runtime-codex/cli';

runCodexMcpCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
