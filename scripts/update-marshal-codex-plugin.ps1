[CmdletBinding()]
param(
    [ValidateSet('DryRun', 'InstallOnly', 'Restart')]
    [string] $Mode = 'DryRun',
    [string] $PluginSource = 'Q:\.q\marshal-memory827-certified-market\plugins\marshal-runtime',
    [string] $MarketplacePath = 'Q:\.q\marshal-memory827-certified-market\.agents\plugins\marketplace.json',
    [string] $AdapterDist = 'Q:\src\marshal-runtime\marshal-agent-runtime\packages\agent-runtime-codex\dist',
    [string] $KernelModule = '',
    [string] $LogPath = "$env:LOCALAPPDATA\Marshal\codex-plugin-restart.log",
    [string] $TaskName = "Marshal-Codex-Restart-$([guid]::NewGuid().ToString('N'))",
    [switch] $Worker,
    [string] $StatePath,
    [switch] $Regenerate,
    [switch] $SkipInstall,
    [string] $TargetExecutable,
    [string[]] $TargetArguments = @(),
    [int] $TargetProcessId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$marketplaceHelper = 'C:\Users\omerm\.codex\skills\.system\plugin-creator\scripts\read_marketplace_name.py'
$cachebusterHelper = 'C:\Users\omerm\.codex\skills\.system\plugin-creator\scripts\update_plugin_cachebuster.py'
$installer = Join-Path $AdapterDist 'pluginCli.js'
$configRpcHelper = Join-Path $PSScriptRoot 'codex-plugin-config-rpc.mjs'

function Write-Log([string] $Message) {
    $parent = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) $Message"
}

function Redact([string] $Text) {
    $withoutUserInfo = [regex]::Replace($Text, '(?i)(https?://)[^/\s@]+@', '$1<redacted>@')
    return [regex]::Replace(
        $withoutUserInfo,
        '(?i)([?&](?:access_token|auth|password|token)=)[^&\s]+',
        '$1<redacted>'
    )
}

function Invoke-Captured([string] $FilePath, [string[]] $Arguments) {
    $output = & $FilePath @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$(Redact $output.Trim()) (exit $exitCode)"
    }
    return $output.Trim()
}

function Assert-File([string] $Path, [string] $Label) {
    if (-not [IO.Path]::IsPathRooted($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing or not an absolute file: $Path"
    }
}

function Get-PluginProfile {
    $mcpPath = Join-Path $PluginSource '.mcp.json'
    if (-not (Test-Path -LiteralPath $mcpPath -PathType Leaf)) { return 'brokered-only' }
    $payload = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
    $server = $payload.mcpServers.'marshal-runtime'
    $profile = [string]$server.env.MARSHAL_RUNTIME_PERMISSION_PROFILE
    switch ($profile) {
        'trusted-local' { return 'trusted-local' }
        'adaptive-agentic' { return 'adaptive-agentic' }
        'bounded-agentic' { return 'bounded-agentic' }
        default { return 'brokered-only' }
    }
}

function Get-InstalledPlugin(
    [string] $ExpectedVersion,
    [string] $MarketplaceName,
    [bool] $RequireEnabled = $true
) {
    $codex = (Get-Command codex.exe -ErrorAction Stop).Source
    $listing = Invoke-Captured $codex @('plugin', 'list', '--json') | ConvertFrom-Json
    $expectedId = "marshal-runtime@$MarketplaceName"
    $record = @($listing.installed) | Where-Object { $_.pluginId -eq $expectedId } | Select-Object -First 1
    if (-not $record) { throw "Installed plugin record $expectedId was not found after install." }
    if ($record.installed -ne $true) { throw "Installed plugin record $expectedId is not marked installed." }
    if ([string]$record.version -ne $ExpectedVersion) { throw "Installed plugin version does not match source manifest." }
    if ([IO.Path]::GetFullPath([string]$record.source.path) -ne [IO.Path]::GetFullPath($PluginSource)) {
        throw "Installed plugin source path does not match the requested source."
    }
    if ($RequireEnabled -and $record.enabled -ne $true) {
        throw "Installed plugin record is not enabled; refusing to report a successful install."
    }
    return [pscustomobject]@{
        pluginId = [string]$record.pluginId
        version = [string]$record.version
        sourcePath = [string]$record.source.path
        installed = [bool]$record.installed
        enabled = [bool]$record.enabled
    }
}

function Get-MarketplaceName {
    $python = (Get-Command python.exe -ErrorAction Stop).Source
    Assert-File $MarketplacePath 'Marketplace'
    Assert-File $marketplaceHelper 'Marketplace-name helper'
    $name = Invoke-Captured $python @($marketplaceHelper, '--marketplace-path', $MarketplacePath)
    if ($name -notmatch '^[A-Za-z0-9_-]+$') { throw "Marketplace helper returned an invalid name." }
    return $name
}

function Install-Plugin {
    $python = (Get-Command python.exe -ErrorAction Stop).Source
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $codex = (Get-Command codex.exe -ErrorAction Stop).Source
    Assert-File $installer 'Codex plugin installer'
    if (-not (Test-Path -LiteralPath $PluginSource -PathType Container)) {
        throw "Plugin source directory is missing: $PluginSource"
    }
    $marketplaceName = Get-MarketplaceName
    $pluginName = 'marshal-runtime'
    if ($Regenerate) {
        $preserved = @()
        foreach ($relativePath in @('.mcp.json', 'hooks\hooks.json')) {
            $path = Join-Path $PluginSource $relativePath
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $preserved += [pscustomobject]@{ Path = $path; Bytes = [IO.File]::ReadAllBytes($path) }
            }
        }
        if ($KernelModule) { Assert-File $KernelModule 'Kernel module' }
        $profile = Get-PluginProfile
        $generatorArgs = @('--destination', $PluginSource, '--force', "--$profile")
        if ($KernelModule) { $generatorArgs += @('--kernel-module', $KernelModule) }
        Write-Log "Regenerating source plugin at $PluginSource with preserved profile $profile"
        Invoke-Captured $node (@($installer) + $generatorArgs) | Out-Null
        foreach ($file in $preserved) { [IO.File]::WriteAllBytes($file.Path, $file.Bytes) }
    } else {
        Write-Log "Refreshing existing source plugin without regenerating user configuration"
    }
    Assert-File $cachebusterHelper 'Cachebuster helper'
    Invoke-Captured $python @($cachebusterHelper, $PluginSource) | Out-Null
    $manifest = Get-Content -LiteralPath (Join-Path $PluginSource '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json
    $version = [string]$manifest.version
    Write-Log "Reinstalling $pluginName from marketplace $marketplaceName"
    Invoke-Captured $codex @('plugin', 'add', "$pluginName@$marketplaceName") | Out-Null
    $installed = Get-InstalledPlugin $version $marketplaceName $false
    Write-Log "Verified installed $($installed.pluginId) version $($installed.version), source=$($installed.sourcePath)"
    Assert-File $configRpcHelper 'Codex config RPC helper'
    Write-Log "Enabling only $pluginName@$marketplaceName through Codex app-server config/value/write"
    Invoke-Captured $node @(
        $configRpcHelper,
        '--mode', 'enable-plugin',
        '--codex', $codex,
        '--marketplace', $marketplaceName
    ) | Out-Null
    $verified = Get-InstalledPlugin $version $marketplaceName
    Write-Log "Verified $($verified.pluginId) version $($verified.version), enabled=$($verified.enabled), source=$($verified.sourcePath)"
    return $verified
}

function Get-CodexDesktopExecutable {
    $candidate = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' } |
        Select-Object -First 1
    if (-not $candidate) { throw 'The targeted Codex desktop app is not running.' }
    return $candidate.Path
}

function Get-CodexAppUserModelId {
    $apps = @(Get-StartApps | Where-Object {
        $_.AppID -match '^OpenAI\.Codex_[A-Za-z0-9]+!App$'
    })
    if ($apps.Count -ne 1) {
        throw "Expected exactly one registered ChatGPT Codex app, found $($apps.Count)."
    }
    return [string]$apps[0].AppID
}

function Get-FreshCodexProcess([DateTime] $RequestedAt) {
    return Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and
            $_.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -and
            $_.StartTime.ToUniversalTime() -ge $RequestedAt.AddSeconds(-1)
        } |
        Sort-Object StartTime |
        Select-Object -First 1
}

function Get-TargetSnapshot([string] $ExecutablePath) {
    $candidates = if ($TargetProcessId -gt 0) {
        Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
    } else {
        Get-Process -ErrorAction SilentlyContinue
    }
    $processes = @($candidates | Where-Object { $_.Path -eq $ExecutablePath } |
        ForEach-Object {
            [pscustomobject]@{
                Id = [int]$_.Id
                Path = [string]$_.Path
                StartTimeUtc = $_.StartTime.ToUniversalTime().ToString('o')
            }
        })
    if ($processes.Count -eq 0) { throw "No running target processes match the resolved executable: $ExecutablePath" }
    return $processes
}

function Test-TargetIdentity($Process, $Target, [string] $ExecutablePath) {
    try {
        return $Process.Path -eq $ExecutablePath -and
            $Process.StartTime.ToUniversalTime().ToString('o') -eq $Target.StartTimeUtc
    } catch {
        return $false
    }
}

function Assert-IsolatedSurrogate([string] $ExecutablePath) {
    if ($TargetProcessId -le 0) {
        throw 'A non-Codex TargetExecutable requires TargetProcessId.'
    }
    $leaf = [IO.Path]::GetFileName($ExecutablePath)
    if ($leaf -in @('node.exe', 'codex.exe', 'ChatGPT.exe', 'pwsh.exe', 'powershell.exe')) {
        throw "Shared executable $leaf cannot be used as a proof target."
    }
    $parent = Split-Path -Parent $ExecutablePath
    if ([IO.Path]::GetFileName($parent) -notmatch '^marshal-restart-surrogate-[A-Za-z0-9_-]+$') {
        throw 'A non-Codex TargetExecutable must be inside a dedicated marshal-restart-surrogate-* directory.'
    }
    $matches = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ExecutablePath })
    if ($matches.Count -ne 1 -or $matches[0].Id -ne $TargetProcessId) {
        throw 'The isolated surrogate path must have exactly one running process matching TargetProcessId.'
    }
}

function Schedule-Restart {
    if (-not $TargetExecutable -and ($TargetProcessId -gt 0 -or $TargetArguments.Count -gt 0)) {
        throw 'TargetProcessId and TargetArguments are only valid with an isolated TargetExecutable.'
    }
    $executable = if ($TargetExecutable) {
        [IO.Path]::GetFullPath($TargetExecutable)
    } else {
        Get-CodexDesktopExecutable
    }
    Assert-File $executable 'Target executable'
    if ($TargetExecutable) { Assert-IsolatedSurrogate $executable }
    $snapshot = @(Get-TargetSnapshot $executable)
    $launchMode = if ($TargetExecutable) { 'executable' } else { 'codex-packaged-app' }
    $appUserModelId = if ($TargetExecutable) { $null } else { Get-CodexAppUserModelId }
    $state = [IO.Path]::Combine([IO.Path]::GetTempPath(), "marshal-codex-restart-$([guid]::NewGuid().ToString('N')).json")
    $targetMode = if ($TargetProcessId -gt 0) { 'explicit-process-id' } else { 'executable-match' }
    [pscustomobject]@{
        Schema = 2
        TaskName = $TaskName
        ScriptPath = $scriptPath
        LogPath = $LogPath
        ExecutablePath = $executable
        LaunchArguments = @($TargetArguments)
        LaunchMode = $launchMode
        AppUserModelId = $appUserModelId
        TargetMode = $targetMode
        Processes = $snapshot
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $state -Encoding UTF8

    $runAt = (Get-Date).AddMinutes(1)
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Mode Restart -Worker -StatePath `"$state`" -TaskName `"$TaskName`""
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Once -At $runAt
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Log "Scheduled independent restart task $TaskName for $runAt; target $executable; PIDs $(([string]::Join(',', $snapshot.Id)))"
    Write-Output ([pscustomobject]@{
        ok = $true
        taskName = $TaskName
        statePath = $state
        executablePath = $executable
        processIds = @($snapshot.Id)
        scheduledFor = $runAt.ToString('o')
    } | ConvertTo-Json -Compress)
}

function Stop-And-Restart {
    Assert-File $StatePath 'Restart state'
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $LogPath = [string]$state.LogPath
    $worker = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    Write-Log "Worker PID $PID parent $($worker.ParentProcessId) task $($state.TaskName)"
    $restartError = $null
    try {
        $verifiedTargets = @()
        foreach ($target in @($state.Processes)) {
            $process = Get-Process -Id ([int]$target.Id) -ErrorAction SilentlyContinue
            if (-not $process) {
                Write-Log "Skipping PID $($target.Id): target already exited."
                continue
            }
            if (-not (Test-TargetIdentity $process $target $state.ExecutablePath)) {
                Write-Log "Skipping PID $($target.Id): refusing a reused or different process."
                continue
            }
            $verifiedTargets += $target
        }
        foreach ($target in $verifiedTargets) {
            $process = Get-Process -Id ([int]$target.Id) -ErrorAction SilentlyContinue
            if (-not $process) {
                Write-Log "Skipping PID $($target.Id): target exited before graceful close."
                continue
            }
            if (-not (Test-TargetIdentity $process $target $state.ExecutablePath)) {
                Write-Log "Skipping PID $($target.Id): identity changed before graceful close."
                continue
            }
            try {
                if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
            } catch {
                Write-Log "Skipping PID $($target.Id): graceful close raced with process exit."
            }
        }
        Start-Sleep -Seconds 5
        $stoppedIds = @()
        foreach ($target in $verifiedTargets) {
            $process = Get-Process -Id ([int]$target.Id) -ErrorAction SilentlyContinue
            if ($process) {
                if (-not (Test-TargetIdentity $process $target $state.ExecutablePath)) {
                    Write-Log "Skipping PID $($target.Id): identity changed; refusing to stop it."
                    continue
                }
                try {
                    Stop-Process -Id ([int]$target.Id) -Force -ErrorAction Stop
                    $stoppedIds += [int]$target.Id
                } catch {
                    Write-Log "Skipping PID $($target.Id): stop raced or was denied."
                }
            } else {
                Write-Log "Skipping PID $($target.Id): target exited before force close."
            }
        }
        if ($stoppedIds.Count -gt 0) {
            Write-Log "Stopped only validated target PIDs $(([string]::Join(',', $stoppedIds)))"
        } else {
            Write-Log 'No validated target PIDs were stopped.'
        }
    } catch {
        $restartError = $_.Exception.Message
        Write-Log "Stop failed: $(Redact $restartError)"
    } finally {
        try {
            $startArgs = @{}
            $requestedAt = [DateTime]::UtcNow
            if ($state.LaunchMode -eq 'codex-packaged-app') {
                if (-not $state.AppUserModelId) { throw 'Packaged Codex restart state has no AppUserModelId.' }
                $appsFolder = "shell:AppsFolder\$($state.AppUserModelId)"
                Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList $appsFolder | Out-Null
                Write-Log "Activated registered Codex app $($state.AppUserModelId)"
            } else {
                if ($state.LaunchArguments) { $startArgs.ArgumentList = @($state.LaunchArguments) }
                Start-Process -FilePath $state.ExecutablePath -WorkingDirectory (Split-Path -Parent $state.ExecutablePath) -WindowStyle Hidden @startArgs | Out-Null
            }
            $observed = $null
            $observationDeadline = [DateTime]::UtcNow.AddSeconds(18)
            while (-not $observed -and [DateTime]::UtcNow -lt $observationDeadline) {
                $observed = if ($state.LaunchMode -eq 'codex-packaged-app') {
                    Get-FreshCodexProcess $requestedAt
                } else {
                    Get-Process -ErrorAction SilentlyContinue |
                        Where-Object {
                            $_.Path -eq $state.ExecutablePath -and
                            $_.StartTime.ToUniversalTime() -ge $requestedAt.AddSeconds(-1)
                        } |
                        Sort-Object StartTime |
                        Select-Object -First 1
                }
                if (-not $observed) { Start-Sleep -Milliseconds 500 }
            }
            if (-not $observed) {
                throw "No fresh process was observed within 18 seconds after starting $($state.ExecutablePath)."
            }
            Write-Log "Restarted PID $($observed.Id) start $($observed.StartTime.ToUniversalTime().ToString('o')) with $(if ($state.LaunchMode -eq 'codex-packaged-app') { 'registered app ' + $state.AppUserModelId } else { 'resolved executable ' + $state.ExecutablePath })"
        } catch {
            $restartError = if ($restartError) { "$restartError; restart failed: $($_.Exception.Message)" } else { "restart failed: $($_.Exception.Message)" }
            Write-Log "Restart failed: $(Redact $_.Exception.Message)"
        }
        try { Unregister-ScheduledTask -TaskName $state.TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    }
    if ($restartError) { throw (Redact $restartError) }
}

try {
    if ($Worker) {
        Stop-And-Restart
    } elseif ($Mode -eq 'DryRun') {
        $marketplace = Get-MarketplaceName
        $installerExists = Test-Path -LiteralPath $installer -PathType Leaf
        $executable = Get-CodexDesktopExecutable
        $snapshot = Get-TargetSnapshot $executable
        [pscustomobject]@{
            ok = $true
            marketplace = $marketplace
            pluginSource = $PluginSource
            installer = $installer
            kernelModule = if ($KernelModule) { $KernelModule } else { $null }
            executablePath = $executable
            targetProcessId = if ($TargetProcessId -gt 0) { $TargetProcessId } else { $null }
            processIds = @($snapshot.Id)
            installerPresent = $installerExists
            wouldInstall = $true
            wouldStop = $false
        } | ConvertTo-Json -Compress
    } elseif ($Mode -eq 'InstallOnly') {
        $verified = Install-Plugin
        $verified | ConvertTo-Json -Compress
    } elseif ($Mode -eq 'Restart') {
        if (-not $SkipInstall) { Install-Plugin | Out-Null }
        Schedule-Restart
    }
} catch {
    Write-Log "ERROR: $(Redact $_.Exception.Message)"
    Write-Error (Redact $_.Exception.Message)
    exit 1
}
