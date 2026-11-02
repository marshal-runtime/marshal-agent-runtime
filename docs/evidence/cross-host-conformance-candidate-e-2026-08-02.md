# Cross-host and standards-only conformance — candidate e

## Claim boundary

`deterministic`, Windows x64, Node `v24.14.0`, Corepack pnpm `10.32.1`.
The focused parity commands first ran at source revision `3e5471f`; the
mandatory complete repository gate was repeated at revision `1cd7b38` after
the separate evidence and capacity-runner commits landed. Candidate `e`
packages runtime commit `c96fadf`. The independently installed package root
exercised by the generic client was:

```text
C:\Users\admin\.marshal\codex-runtime-0.1.0-20260802e\node_modules\@marshal\agent-runtime-codex
```

This evidence proves portable protocol behavior, the unchanged shared
application contract at both the standards-only and Codex resource edges, and
the installed candidate's generic stdio path. It is not browser pixels, iframe
sandbox/CSP enforcement, a named third-party harness integration, or remote
HTTP/authentication evidence.

## Shared conformance

```powershell
corepack pnpm --filter @marshal/agent-runtime-conformance test
```

Result: four files and six Vitest tests passed, zero failed. The assertions
inside those tests reported:

- structural self-test fixture: 12 passed, 0 failed, 0 skipped;
- generic portable composer: 11 passed, 0 failed, 1 intentional legacy-alias
  skip because the generic fixture does not advertise those aliases;
- standards-only adaptive MCP Apps application: 8 passed, 0 failed;
- published `@modelcontextprotocol/ext-apps` `AppBridge`: initialization,
  initialized notification, host context, fullscreen fallback, PiP unsupported
  outcome, lifecycle notifications, and one permission-receipted action passed.

The eight adaptive cases were renderer/resource metadata, complete fallback,
stable cached display, immutable manifest recovery, display-mode negotiation,
host-context lifecycle, declared actions, and restart/scope isolation.

## Codex edge running the same contracts

```powershell
corepack pnpm --filter @marshal/agent-runtime-codex exec vitest run --config vitest.config.ts src/__tests__/conformance.spec.ts
corepack pnpm --filter @marshal/agent-runtime-codex-capabilities test
```

Results:

- real Codex MCP dispatcher: the same structural suite reported 12 passed,
  0 failed, 0 skipped;
- Codex composite MCP Apps resource adapter: the same eight application cases
  reported 8 passed, 0 failed;
- complete Codex-capabilities package: 43 passed, 0 failed, 2 skipped. The skips
  were the opt-in real-backend smoke and a POSIX-only case-sensitive-path test
  on Windows.

## Installed candidate through a generic MCP client

```powershell
node scripts/smoke-detached-mcp.mjs --deployment "C:\Users\admin\.marshal\codex-runtime-0.1.0-20260802e\node_modules\@marshal\agent-runtime-codex"
```

The unrelated temporary workspace and generic MCP SDK stdio client passed all
smoke assertions:

- no development-repository path was present in the installed package;
- `runtime_search` and `runtime_exec` were registered;
- broad discovery was summary-only and exact discovery returned full schemas;
- brokered TypeScript executed and emitted a durable receipt;
- lifecycle delivery replayed idempotently in-process and after server restart;
- explicit scoped memory survived the process restart;
- the receipt journal preserved both pre- and post-restart receipts;
- the renderer resource used `text/html;profile=mcp-app`, stable versioned tool
  metadata, a complete fallback, and inline/fullscreen/PiP manifest data;
- the same render reopened after restart;
- a second workspace could not access the first workspace's render;
- the adapter's native delegation dependency resolved to `@openai/codex`
  `0.144.6` with its CLI entrypoint present.

## Security and dependency boundaries

```powershell
corepack pnpm boundaries
corepack pnpm --filter @marshal/agent-runtime-ui test
corepack pnpm --filter @marshal/agent-runtime-typescript test
corepack pnpm --filter @marshal/agent-runtime-host test
corepack pnpm --filter @marshal/agent-runtime-codex test
```

Results:

- dependency-direction gate: 20 portable packages classified, all clean;
- portable UI: 58 passed, 0 failed, including package authority, signed record
  integrity, tamper rejection, traversal/builtin/package denial, declared action
  authorization, durable idempotency, project isolation, and 100 cached reopens;
- TypeScript: 21 passed, 0 failed, including explicit trusted package/builtin
  grants, policy-separated caches, timeout/cancellation, and edited-source
  fingerprints;
- portable host: 28 passed, 0 failed, 2 POSIX-only skips on Windows, including
  protected-root fail-closed behavior, default approval gating, lifecycle
  replay, scoped state, and parent-linked nested receipts;
- complete Codex adapter: 73 passed, 0 failed, including adapter dependency
  direction, stable identity, stdio, permissions, UI authority, hooks,
  delegation, cancellation cleanup, and the shared conformance fixture.

The mandatory repository-wide command was also run:

```powershell
corepack pnpm verify
```

The first attempt hit the 20-second timeout in the effects package's 32-node
delegation-store test while all preceding parity suites were green. The exact
test passed alone in 3.060 seconds. A complete clean rerun then passed; on that
rerun the same 32-node test completed in 5.492 seconds, the shared conformance
suite remained 6/6, the portable UI suite remained 58/58, the complete Codex
adapter remained 73/73, and dry-run tarballs validated for all 20 packages.
This is recorded as a load-sensitive timeout followed by isolated and complete
green reruns, not hidden as an uninterrupted first-attempt pass.

## Remaining external-host gap

The reusable structural seams are proven, but the release still needs one
named non-Codex host to consume the published packages without fixture
substitution and retain an uncut trace. For MCP Apps, the published `AppBridge`
integration is protocol-host evidence only: the upstream reference host is a
source-only Vite/React double-iframe application, not an embeddable package API.
Browser rendering, iframe sandbox and CSP enforcement, actual inline/fullscreen/
PiP presentation, clicks, resize/safe-area/theme behavior, hydration fallback
timing, and restart pixels therefore remain live-host gates. Generic remote
HTTP transport, authentication, and public plugin connection/submission also
remain outside this local stdio proof.
