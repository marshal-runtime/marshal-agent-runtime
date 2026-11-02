# Marshal Runtime Codex plugin update and restart

`scripts\update-marshal-codex-plugin.ps1` updates the existing local
`marshal-runtime@marshal-memory827-certified` plugin without editing
`marketplace.json` or `config.toml`. It uses the local plugin-creator helpers and
the current adapter installer. The normal generated server entrypoint remains
the adapter's `cli.js`; a kernel module is only supplied when explicitly passed
as an absolute binding-factory module.

Run from an elevated or normal PowerShell prompt as the interactive user:

```powershell
$s = 'Q:\src\marshal-runtime\marshal-agent-runtime\scripts\update-marshal-codex-plugin.ps1'
& $s -Mode DryRun
& $s -Mode InstallOnly
& $s -Mode Restart
```

`DryRun` validates the explicit marketplace name, source and installer paths,
and the exact running Codex desktop executable/PIDs without changing anything.
`InstallOnly` refreshes only the existing source manifest cachebuster by default,
then runs `codex plugin add marshal-runtime@marshal-memory827-certified`; it
never stops the app. `Restart` performs the same install first, then registers a
one-shot interactive Task Scheduler task. The task owns the hidden worker after
the launching Codex process exits, validates every saved PID by exact executable
path and start time, closes/terminates only those PIDs, and starts the resolved
`ChatGPT.exe` path in `finally`. Failures are logged to
`%LOCALAPPDATA%\Marshal\codex-plugin-restart.log` with credential-bearing URL
components redacted. The install step verifies the exact plugin ID, version,
source path, installed flag, and boolean enabled state from `codex plugin list
--json`; an install failure never schedules or stops the app. No plugin cache
file is used as worker state.

Use `-Regenerate` only when intentionally regenerating the source. It preserves
the existing `.mcp.json`, `hooks\hooks.json`, and permission profile. The
optional `-KernelModule` must be an absolute binding-factory module; omit it
for the normal adapter `cli.js` server entrypoint.

The install path uses the installed Codex app-server JSON-RPC API after
`codex plugin add`. It writes only
`plugins."marshal-runtime@<validated-marketplace>".enabled=true` through
`config/value/write` with `mergeStrategy: "upsert"`, then requires the exact
plugin record to report `enabled=true`. The sibling RPC helper can also perform
a non-secret read without printing the effective config:

```powershell
$codex = (Get-Command codex.exe).Source
node scripts\codex-plugin-config-rpc.mjs `
  --mode read `
  --codex $codex `
  --marketplace marshal-memory827-certified
```

For an isolated write check, redirect the app-server's user layer with a
disposable `CODEX_HOME`; do not pass a foreign `filePath`, because Codex only
permits writes to its selected user config:

```powershell
node scripts\codex-plugin-config-rpc.mjs `
  --mode enable-plugin `
  --codex $codex `
  --marketplace marshal-memory827-certified `
  --codex-home Q:\temp\marshal-codex-home-config-rpc-20260828
```

During a parent-authorized `InstallOnly` or `Restart`, the PowerShell wrapper
omits `--codex-home`, so the supported app-server operation updates the real
user layer only after the CLI install succeeds.

## Independent detached-survival proof

Do not use the real app for the proof. Use a disposable copy of
`ChatGPT.exe`-compatible test target or a harmless surrogate executable and a
separate temporary script invocation. Record the exact launcher PID, scheduled
task name, worker PID/start time, target PID/path/start time, and log timestamps:

```powershell
schtasks.exe /Query /TN <task-name> /V /FO LIST
Get-Process -Id <launcher-pid>,<worker-pid>,<target-pid> |
  Select-Object Id,Path,StartTime
Get-Content "$env:LOCALAPPDATA\Marshal\codex-plugin-restart.log"
```

The production dispatch path can be exercised safely with a hidden, long-lived
Node surrogate and no install:

```powershell
& $s -Mode Restart -SkipInstall `
  -TargetExecutable 'Q:\temp\marshal-restart-surrogate-20260828\marshal-restart-surrogate.exe' `
  -TargetArguments @('Q:\src\marshal-runtime\marshal-agent-runtime\scripts\marshal-restart-surrogate.mjs') `
  -TargetProcessId <surrogate-pid> `
  -LogPath "$env:LOCALAPPDATA\Marshal\codex-plugin-restart-proof-20260828.log"
```

Capture the task name and state path from its JSON output. Terminate the
disposable launcher process/job immediately after it creates the task. Verify
the task worker still runs outside that launcher, validates the original target,
stops that exact PID, and starts a new surrogate with a fresh PID and start
time that remains alive. The target must be a uniquely copied executable;
never use shared `node.exe`, `codex.exe`, or another existing process image.
The worker log records the restarted PID and UTC start time, which must be
confirmed with `Get-Process` before cleaning the exact proof task, surrogate,
fixture copy, and state file. This proves OS-owned survival through the
production dispatch and worker code rather than ordinary child detachment.
The real Codex app remains untouched until the parent rollout explicitly runs
`-Mode Restart`.
