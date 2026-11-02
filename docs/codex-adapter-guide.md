# Codex reference adapter: installed-plugin guide

Marshal's Codex integration is a detachable adapter. The portable runtime does
not import Codex; the installed plugin contributes a skill, an MCP server, and
lifecycle hooks at the product boundary.

## Durable owner identity

Programmatic adapters should pass a stable `identity.userId` or
`identity.profileId`. The packaged adapter accepts the equivalent
`MARSHAL_RUNTIME_USER_ID` and `MARSHAL_RUNTIME_PROFILE_ID` configuration. Marshal
hashes that value together with the installation identity into an opaque
principal namespace; raw user/profile identifiers are not used as storage
paths or receipt owner IDs.

Codex does not currently guarantee a signed-in profile identifier through the
stdio MCP launch contract. When neither identity value nor an explicit
`principal` is supplied, Marshal therefore labels the boundary
`installation-local-single-user`. It persists across tasks under that Codex
home, but it is not a multi-user security boundary. A shared OS account or
shared `CODEX_HOME` must configure separate stable identities (and preferably
separate database/storage roots) before cross-session memory is enabled for
multiple people.

Live validation deliberately uses a blank or unrelated repository so success
cannot depend on the active workspace.

## Build and install a source checkout

Requires Node 24.14 or newer from an official distribution, or a compatible
build whose built-in SQLite enables FTS5:

```powershell
corepack pnpm --filter @marshal/agent-runtime-codex... build

$Version = "0.1.0+local.$(Get-Date -Format yyyyMMddHHmmss)"
$MarketplaceRoot = Join-Path $env:LOCALAPPDATA 'marshal-runtime-marketplace'
$PluginRoot = Join-Path $MarketplaceRoot 'plugins\marshal-runtime'
$ManifestRoot = Join-Path $MarketplaceRoot '.agents\plugins'
New-Item -ItemType Directory -Force $ManifestRoot | Out-Null

node .\packages\agent-runtime-codex\dist\pluginCli.js `
  --destination $PluginRoot `
  --plugin-version $Version `
  --adaptive-agentic `
  --force

@'
{
  "name": "marshal-local",
  "interface": { "displayName": "Marshal Local" },
  "plugins": [{
    "name": "marshal-runtime",
    "source": { "source": "local", "path": "./plugins/marshal-runtime" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
'@ | Set-Content -Encoding utf8 (Join-Path $ManifestRoot 'marketplace.json')

corepack pnpm exec codex plugin marketplace add $MarketplaceRoot --json
corepack pnpm exec codex plugin add marshal-runtime@marshal-local --json
```

These commands use the checkout-pinned `@openai/codex` CLI. The marketplace
manifest is
`%LOCALAPPDATA%\marshal-runtime-marketplace\.agents\plugins\marketplace.json`;
its plugin source is relative to the marketplace root. The expected installed
identity is `marshal-runtime@marshal-local` at `$Version`. Use a new version
after every source change so Codex creates a new local cache entry. The
generator does not edit marketplace state.

The generated source-checkout bundle intentionally pins Node, MCP, and hook
entrypoints to this checkout's built `dist`. A globally installed package can
instead run `agent-runtime-codex-install-plugin` with the same options to
produce a relocatable installed-package bundle.

The default bundle is brokered/default-deny. Generate with `--bounded-agentic`
for autonomous native-agent coordination only. Generate with
`--adaptive-agentic` for the normal adaptive-application profile: it adds
agent-authored React compilation to bounded delegation while continuing to
deny trusted Node execution, wildcard package/builtin imports, network, and
effects. Generate with `--trusted-local` only for a deliberately trusted local
environment that should allow wildcard local imports as well. Every agentic
profile remains subject to Marshal's depth, count, concurrency, time,
token/cost, workspace, permission, and effect limits. Codex sandbox and
approval policy still apply outside Marshal's broker.

## What the installed contract owns

- The skill teaches natural selection of memory, editable TypeScript,
  capability composition, delegation, and persistent/custom UI.
- The MCP server exposes `runtime_search`, `runtime_exec`, and startup-stable
  render tools.
- Hooks own task start, durable prompt/tool/completion observation enqueueing,
  and task end. They never run Luna or implement recall/store policy.
- Hook processes use the lifecycle-only runtime entry point. They initialize
  identity, lifecycle receipts, memory, and a slim Memory Brain job producer;
  the effects manager and full MCP provider graph are never started on the hook
  critical path. The long-lived MCP host owns warm Luna workers and recovery.
- The generated MCP environment sets `MARSHAL_RUNTIME_LIFECYCLE_TOOLS=hidden`,
  so the model does not duplicate lifecycle calls that hooks already deliver.
- A task maps to one lifecycle session. Ordinary assistant replies do not end
  that session.

Install or update the plugin, then start a **new task**. Codex loads plugin
skills and tools when the task starts; an already-running task is not a valid
hot-registration test.

## Blank-repository validation

Create a folder that is not inside this checkout and use it as the Codex
workspace. Ask for outcomes naturally; do not mention Marshal or a tool name.
Use these exact prompts in separate new tasks:

1. Session A: `Remember this as my standing preference across future tasks and workspaces: use Celsius for temperatures and always show the unit. Confirm only after it is durably saved.`
2. Session B: `What is my standing preference for reporting temperatures? Answer from durable prior evidence, not from this task's chat history.`

Then exercise context, impact, correction, forgetting, and background
reflection naturally in new tasks. Fully restart Codex before the final recall;
reusing an already-running task or process is not a valid plugin-refresh test.

These prompts test automatic routing. They are not evidence until the task
trace records selected tools, arguments, receipts, installed plugin version,
Codex version, permission profile, and result.

Repository contributors can independently verify the globally installed MCP
entrypoint from any unrelated directory:

```powershell
pnpm smoke:installed-codex C:\path\to\blank-workspace
```

That smoke test is deterministic and model-free. It verifies process startup,
the required tool inventory, and capability discovery. It does not prove skill
selection, hook delivery, UI pixels, native subagents, or memory across two
real tasks; those remain live evaluation gates.

Contributors can target one exact detached candidate without relying on the
globally installed PATH entrypoint:

```powershell
$env:MARSHAL_CODEX_ENTRYPOINT = 'C:\absolute\path\to\candidate\dist\cli.js'
pnpm smoke:installed-codex C:\path\to\blank-workspace
Remove-Item Env:\MARSHAL_CODEX_ENTRYPOINT
```

The smoke creates the blank workspace when it does not exist. This override is
only a validation aid; generated plugin bundles continue to use the stable
PATH-based commands shown above.

## Update discipline

Regenerate the bundle after changing tool schemas, hook projections, skill
routing, or package version. Pass a new `--plugin-version`, reinstall it with
`codex plugin add`, fully restart Codex, and start a new task. Record the
package version and plugin version separately in release evidence.

When the MCP server should use a detachable composition, pass its absolute ESM
entrypoint to the installer with `--kernel-module`. The generated `.mcp.json`
pins that module as `AGENT_RUNTIME_KERNEL_MODULE`; lifecycle hooks remain on
the adapter's intentionally small memory-only entrypoint.

OpenAI's current product documentation says installed plugin capabilities are
picked up in new chats/tasks and recommends testing direct, indirect,
follow-up, negative, authorization, and unsupported requests. See
[Build plugins](https://developers.openai.com/plugins/build/plugins) and
[Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).
