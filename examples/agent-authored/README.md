# Agent-authored runtime examples

Runnable references for the runtime prompt guidance (prompt-implementation/runtime-guidance.md):

- `StatusPanel.tsx` — a real React component compiled with `ui.compile` and rendered with `ui.render` plus an application manifest (declared action, local state, inline/fullscreen presentation). Exercised end-to-end by `packages/agent-runtime-ui/src/__tests__/agentAuthoredExample.spec.ts`: real esbuild compile, catalog `ui_application` publication, render-tool payload retrieval, and a happy-dom mount of the compiled HTML in the sandboxed renderer with declared-action chrome. Its exported `nextActionKey` documents the idempotency-key policy (new intent → new key; retry → same key).
- `triage-report.ts` — a brokered TypeScript workflow composing capabilities with the discipline the guidance requires: exact-name descriptor inspection before invoking, structured `failed`/`partial` results (never silent success on invalid data or failed rendering), best-effort mid-work notifications with input-level idempotency keys, and honest `prepared`-not-visible UI reporting. Exercised by `packages/agent-runtime-typescript/__tests__/agentComposedWorkflow.spec.ts` through the real sandboxed executor with an observable fixture broker. `triage.items.list` is a FIXTURE capability, not a production one — callers supply their own data capability.

Nothing here touches a live host, profile, or session; specs run against temp workspaces only.
