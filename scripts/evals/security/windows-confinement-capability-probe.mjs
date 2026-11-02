#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WINDOWS_CONFINEMENT_PROBE_SCHEMA_VERSION = '1.0.0';

export const WINDOWS_CONFINEMENT_CONTRACT_INVARIANTS = Object.freeze([
  'policy-before-target-start',
  'mandatory-descendant-inheritance',
  'parent-only-model-transport',
  'deny-external-data-egress-for-descendants',
  'read-only-filesystem-outside-attempt',
  'kill-complete-process-tree',
  'loaded-kernel-policy-measurement',
]);

const POWERSHELL_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class MarshalWindowsConfinementNativeProbe {
    private const UInt32 LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
    private const UInt32 TOKEN_QUERY = 0x0008;
    private const Int32 TokenIsAppContainer = 29;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, UInt32 flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string procedureName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, UInt32 desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, Int32 informationClass, out UInt32 information, UInt32 informationLength, out UInt32 returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static bool HasExport(string library, string procedureName) {
        IntPtr module = LoadLibraryExW(library, IntPtr.Zero, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (module == IntPtr.Zero) return false;
        try { return GetProcAddress(module, procedureName) != IntPtr.Zero; }
        finally { FreeLibrary(module); }
    }

    public static bool CurrentProcessIsInJob() {
        bool result;
        if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out result)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return result;
    }

    public static bool CurrentTokenIsAppContainer() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            UInt32 value;
            UInt32 returned;
            if (!GetTokenInformation(token, TokenIsAppContainer, out value, sizeof(UInt32), out returned)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            return value != 0;
        }
        finally { CloseHandle(token); }
    }
}
'@

function Service-State([string] $name) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $service) { return 'Missing' }
    return [string] $service.Status
}

$os = Get-CimInstance Win32_OperatingSystem
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$processModelPath = Join-Path $env:WINDIR 'System32\processmodel.dll'
$processModel = Get-Item -LiteralPath $processModelPath -ErrorAction SilentlyContinue

[ordered]@{
    ok = $true
    os = [ordered]@{
        caption = [string] $os.Caption
        version = [string] $os.Version
        buildNumber = [string] $os.BuildNumber
        architecture = [string] $os.OSArchitecture
    }
    token = [ordered]@{
        isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        isAppContainer = [MarshalWindowsConfinementNativeProbe]::CurrentTokenIsAppContainer()
        currentProcessIsInJob = [MarshalWindowsConfinementNativeProbe]::CurrentProcessIsInJob()
    }
    services = [ordered]@{
        baseFilteringEngine = Service-State 'BFE'
        windowsFirewall = Service-State 'mpssvc'
    }
    jobObject = [ordered]@{
        create = [MarshalWindowsConfinementNativeProbe]::HasExport('kernel32.dll', 'CreateJobObjectW')
        assign = [MarshalWindowsConfinementNativeProbe]::HasExport('kernel32.dll', 'AssignProcessToJobObject')
        configure = [MarshalWindowsConfinementNativeProbe]::HasExport('kernel32.dll', 'SetInformationJobObject')
        query = [MarshalWindowsConfinementNativeProbe]::HasExport('kernel32.dll', 'QueryInformationJobObject')
        terminate = [MarshalWindowsConfinementNativeProbe]::HasExport('kernel32.dll', 'TerminateJobObject')
    }
    processSandbox = [ordered]@{
        dllPresent = $null -ne $processModel
        fileVersion = if ($null -eq $processModel) { $null } else { [string] $processModel.VersionInfo.FileVersion }
        createProcess = [MarshalWindowsConfinementNativeProbe]::HasExport('processmodel.dll', 'Experimental_CreateProcessInSandbox')
        createProcessAsUser = [MarshalWindowsConfinementNativeProbe]::HasExport('processmodel.dll', 'Experimental_CreateProcessAsUserInSandbox')
        experimental = $true
    }
} | ConvertTo-Json -Depth 6 -Compress
`;

export function evaluateWindowsConfinementFacts(facts, options = {}) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const blockers = [];
  const observations = normalizeFacts(facts);

  if (platform !== 'win32') blockers.push('host-platform-is-not-windows');
  if (observations.ok !== true) blockers.push('windows-native-capability-probe-failed');

  const jobApiSurfaceAvailable = observations.ok === true
    && ['create', 'assign', 'configure', 'query', 'terminate'].every((key) => observations.jobObject[key] === true);
  const processSandboxApiAvailable = observations.ok === true
    && observations.processSandbox.dllPresent === true
    && observations.processSandbox.createProcess === true;
  const kernelNetworkServicesRunning = observations.ok === true
    && observations.services.baseFilteringEngine === 'Running'
    && observations.services.windowsFirewall === 'Running';

  if (platform === 'win32' && !jobApiSurfaceAvailable) blockers.push('windows-job-object-api-surface-incomplete');
  if (platform === 'win32' && !processSandboxApiAvailable) blockers.push('windows-process-sandbox-api-unavailable');
  if (platform === 'win32' && !kernelNetworkServicesRunning) blockers.push('windows-kernel-network-filtering-services-unavailable');
  if (platform === 'win32' && observations.token.isAdministrator !== true) {
    blockers.push('current-token-cannot-install-or-configure-a-privileged-confinement-provider');
  }

  // These are contract gaps, not failed API discovery. Job Objects constrain a
  // process tree but do not constrain its network or filesystem access.
  // AppContainer/ProcessContainer constrains the complete token-inheriting tree,
  // so granting model transport to the Codex process also grants it to children.
  // Stock user-mode primitives do not emit an attestation of the exact loaded
  // kernel policy either. A reviewed external provider (for example a signed WFP
  // callout plus a privileged policy service, or a separately attested VM
  // boundary) is therefore still required.
  blockers.push(
    'no-reviewed-external-kernel-policy-provider-is-configured',
    'stock-tree-inherited-token-cannot-enforce-parent-only-model-transport',
    'loaded-kernel-policy-measurement-is-unavailable',
  );

  const evidence = {
    schemaVersion: WINDOWS_CONFINEMENT_PROBE_SCHEMA_VERSION,
    probeOnly: true,
    platform: `${platform}-${architecture}`,
    releaseEligible: false,
    conclusion: 'external-reviewed-kernel-provider-required',
    contractInvariants: WINDOWS_CONFINEMENT_CONTRACT_INVARIANTS,
    primitiveAssessment: {
      jobObject: {
        apiSurfaceAvailable: jobApiSurfaceAvailable,
        canPreventConfiguredBreakaway: jobApiSurfaceAvailable,
        canKillCompleteAssociatedTree: jobApiSurfaceAvailable,
        canConstrainNetwork: false,
        canConstrainFilesystem: false,
      },
      processSandbox: {
        apiSurfaceAvailable: processSandboxApiAvailable,
        experimental: observations.processSandbox.experimental === true,
        canApplyUniformTreeNetworkPolicy: processSandboxApiAvailable,
        canApplyUniformTreeFilesystemPolicy: processSandboxApiAvailable,
        canGiveOnlyParentModelTransport: false,
      },
      stockWindowsFiltering: {
        servicesRunning: kernelNetworkServicesRunning,
        reviewedMarshalCalloutInstalled: false,
        canAttestLoadedMarshalPolicy: false,
      },
    },
    hostFacts: observations,
    blockers: [...new Set(blockers)].sort(),
  };

  return {
    ...evidence,
    evidenceSha256: sha256(canonicalJson(evidence)),
  };
}

export function runWindowsConfinementCapabilityProbe(options = {}) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== 'win32') {
    return evaluateWindowsConfinementFacts({
      ok: false,
      error: 'The Windows capability probe was not executed on a non-Windows host.',
    }, { platform, architecture });
  }

  const readFacts = options.readFacts ?? readNativeWindowsFacts;
  try {
    return evaluateWindowsConfinementFacts(readFacts(options), { platform, architecture });
  } catch (error) {
    return evaluateWindowsConfinementFacts({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, { platform, architecture });
  }
}

export function readNativeWindowsFacts(options = {}) {
  const encodedCommand = Buffer.from(POWERSHELL_PROBE, 'utf16le').toString('base64');
  const result = (options.spawnSync ?? spawnSync)(
    options.powerShellCommand ?? 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
    {
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
      timeout: options.timeoutMs ?? 15_000,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PowerShell capability probe exited ${String(result.status)}: ${String(result.stderr ?? '').trim() || 'no diagnostic'}`);
  }
  try {
    return JSON.parse(String(result.stdout ?? '').trim());
  } catch (error) {
    throw new Error(`PowerShell capability probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeFacts(facts) {
  if (!facts || typeof facts !== 'object' || facts.ok !== true) {
    return {
      ok: false,
      error: typeof facts?.error === 'string' ? facts.error : 'No trustworthy Windows host facts were returned.',
      os: {},
      token: {},
      services: {},
      jobObject: {},
      processSandbox: {},
    };
  }
  return {
    ok: true,
    os: objectOrEmpty(facts.os),
    token: objectOrEmpty(facts.token),
    services: objectOrEmpty(facts.services),
    jobObject: objectOrEmpty(facts.jobObject),
    processSandbox: objectOrEmpty(facts.processSandbox),
  };
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function usageError(message) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: WINDOWS_CONFINEMENT_PROBE_SCHEMA_VERSION,
    ok: false,
    probeOnly: true,
    error: message,
  })}\n`);
  process.exitCode = 64;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--attest') || args.includes('--run')) {
    usageError('This executable is a capability probe, not a confinement launcher. It cannot attest or run release evidence.');
    return;
  }
  if (args.some((arg) => !['--probe', '--require-release'].includes(arg))) {
    usageError('Usage: windows-confinement-capability-probe.mjs [--probe] [--require-release]');
    return;
  }
  const report = runWindowsConfinementCapabilityProbe();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (args.includes('--require-release') && report.releaseEligible !== true) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
