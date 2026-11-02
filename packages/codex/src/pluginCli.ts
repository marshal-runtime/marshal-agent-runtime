#!/usr/bin/env node
import { runCodexPluginInstaller } from '@marshal/agent-runtime-codex/plugin-cli';

runCodexPluginInstaller().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
