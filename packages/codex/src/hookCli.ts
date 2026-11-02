#!/usr/bin/env node
import { runCodexHookCli } from '@marshal/agent-runtime-codex/hook-cli';

process.exitCode = await runCodexHookCli();
