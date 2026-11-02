# Portable Agent Runtime

This repository contains only harness-independent runtime packages and detachable harness adapters.

## Architecture rules

- Portable packages must not import Codex, ChatGPT, Electron, or another harness implementation.
- Harness adapters may depend on portable packages; portable packages must never depend on adapters.
- MCP is the universal capability/resource plane. Hooks and native callbacks are optional adapter planes.
- Workflows, stages, and lambdas are not runtime abstractions.
- All execution, UI, code-intelligence, delegation, and storage operations require bounded inputs, explicit scopes, permissions, and receipts.
- Every adapter must pass the shared conformance suite.

## Verification

Run `pnpm verify` before committing.
