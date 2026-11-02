# Generic MCP quickstart

This quickstart connects an ordinary MCP stdio client to Marshal without using
Codex hooks, prompts, or UI. The neutral distribution is `@marshal/runtime@0.1.0`,
with a `marshal-runtime-mcp` stdio executable and a reusable
`@marshal/runtime/mcp` dispatcher. The existing
`@marshal/agent-runtime-codex@0.1.0` reference distribution remains available for
Codex plugins and its explicitly selected composition.

This is a reference distribution, not a claim that every MCP host implements
MCP Apps, lifecycle callbacks, native effects, or delegation. A generic host
gets the capability plane: discovery, execution, structured results, scoped
permissions, and receipts. Unsupported host-native effects remain explicit.

## Install and connect

The complete Marshal host requires Node 24.14 or newer from an official
distribution, or a compatible build whose built-in SQLite enables FTS5. The
lower-level packages that do not compose memory retain their narrower engine
requirements. After the packages are published, install
the pinned Runtime distribution:

```bash
npm install --global @marshal/runtime@0.1.0
```

Configure an MCP client to launch the server from an unrelated workspace:

```json
{
  "command": "marshal-runtime-mcp",
  "env": {
    "MARSHAL_RUNTIME_MCP_CONFIG": "{\"workspacePath\":\"/absolute/path/to/workspace\",\"privateRoot\":\"/absolute/private/marshal\",\"principalId\":\"stable-owner\",\"sessionId\":\"stable-task\",\"harnessId\":\"my-harness\",\"permissionPatterns\":[\"runtime.inline_module.execute\",\"runtime.module.execute\"]}"
  }
}
```

Launch a separate connection for each trusted session. Identity and workspace
authority come from the host configuration, never model tool arguments. For
Acme, the gateway-owned adapter manages those connections from authenticated
caller identity or durable run claims, using ADK's native tool interface.
For a custom composition, pass
`createAgentRuntime()`'s kernel and optional resource/lifecycle ports to
`createRuntimeMcpServer()`; no Codex adapter is required.

## Durable wakeups and cron

To let an agent set its own wakeups, add `"schedule": {"rootDirectory": "/absolute/schedules"}`
to `MARSHAL_RUNTIME_MCP_CONFIG` and grant `runtime.schedules.create`,
`runtime.schedules.read` and the other `runtime.schedules.*` permissions the
agent needs. The agent then calls `runtime.schedules.create` with a `once`,
`interval`, or `cron` timing and an `agent.wake` task. The MCP process only
stores the schedule. Run `marshal-runtime-scheduler` on the same root to fire it,
even after the session ended:

```json
{
  "command": "marshal-runtime-scheduler",
  "env": {
    "MARSHAL_RUNTIME_SCHEDULER_CONFIG": "{\"rootDirectory\":\"/absolute/schedules\",\"wake\":{\"command\":[\"/absolute/path/resume-agent\"]}}"
  }
}
```

The wake command, or `{"http":{"url":"https://..."}}`, is chosen by the host. It
receives the wake as JSON on stdin and in `MARSHAL_WAKE_SESSION_ID`,
`MARSHAL_WAKE_AGENT_ID`, `MARSHAL_WAKE_MESSAGE`, `MARSHAL_WAKE_SCHEDULE_ID` and
`MARSHAL_WAKE_FIRE_ID`. Exit code 0, or a 2xx answer, marks the fire done.

The server must be launched by the MCP client. Do not run it in a terminal and
expect a human-readable prompt; stdout is reserved for MCP frames.

## Discover, then execute

Call `runtime_search` when the operation name is unknown:

```json
{
  "query": "execute brokered TypeScript",
  "limit": 5
}
```

Broad discovery is compact by default: matches identify and rank capabilities
but omit their potentially large schemas and annotations. Resolve the selected
name once to obtain its complete descriptor before invocation:

```json
{
  "name": "runtime.inline_module.execute"
}
```

Exact-name lookup always returns `detail: "full"` with input/output schemas.
Legacy clients that require schemas for every broad match can add
`"detail": "full"` to the first request.

Invoke the exact returned capability through `runtime_exec`:

```json
{
  "targetType": "operation",
  "target": "runtime.inline_module.execute",
  "input": { "source": "export default () => ({ ready: true })" }
}
```

Disposable brokered TypeScript uses `targetType: "inline_module"`. Reusable,
editable source uses `targetType: "module"` and a workspace-relative file:

```json
{
  "targetType": "module",
  "module": {
    "kind": "workspace_file",
    "path": "automation/summarize.ts"
  },
  "input": { "records": [] },
  "timeoutMs": 60000
}
```

`timeoutMs` is the outer wall-clock budget for the complete module. Set it
explicitly when the module waits on nested capabilities: it must be greater
than the longest nested wait plus execution overhead and no higher than the
maximum advertised by the `runtime_exec` tool. A nested call's own timeout does
not extend the outer module budget.

The default permission profile is brokered and default-deny. Trusted Node
execution and package/builtin imports require explicit host policy; an MCP
connection does not grant them implicitly.

## Verify the detached package

Repository contributors can build a self-contained deployment in a temporary
directory, start it from a blank workspace outside the repository, and exercise
both discovery and TypeScript execution with a generic MCP SDK client:

```bash
pnpm smoke:detached-mcp
```

This existing smoke uses the Codex reference distribution and its selected
providers. The neutral entrypoint has separate tests in `packages/runtime/test`
and Acme's gateway integration tests exercise the real ADK transport into that CLI.
The smoke test fails if the deployment contains the development-repository
path, omits `runtime_search` or `runtime_exec`, returns no capabilities, or
cannot execute a brokered inline module. It also restarts the server to verify
lifecycle idempotency, durable memory and execution receipts, reopens the same
standards-only MCP Apps render, and checks workspace isolation. It removes its
temporary deployment on completion and does not use a model or paid API.

To certify an already-built release candidate rather than creating another
deployment, pass its absolute directory. The candidate itself is never changed
or removed:

```powershell
node scripts/smoke-detached-mcp.mjs --deployment C:\absolute\path\to\candidate
```

For manual protocol inspection, the official OpenAI plugin testing guide
recommends [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector@latest
```

HTTP deployment, authentication, and public plugin submission are separate
release concerns; this repository currently verifies the local stdio
distribution only. See OpenAI's [MCP server guide](https://developers.openai.com/plugins/build/mcp-server)
and [connection/testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
