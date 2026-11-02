param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('probe', 'run')]
    [string] $Mode,

    [Parameter(Mandatory = $true)]
    [int] $OwnerPid
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MarshalWindowsJobObjectHost {
    private const UInt32 CREATE_SUSPENDED = 0x00000004;
    private const UInt32 CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const UInt32 STARTF_USESTDHANDLES = 0x00000100;
    private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const UInt32 SYNCHRONIZE = 0x00100000;
    private const UInt32 INFINITE = 0xffffffff;
    private const UInt32 WAIT_OBJECT_0 = 0;
    private const Int32 JobObjectExtendedLimitInformation = 9;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
        public UInt32 nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public UInt32 cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public UInt32 dwX;
        public UInt32 dwY;
        public UInt32 dwXSize;
        public UInt32 dwYSize;
        public UInt32 dwXCountChars;
        public UInt32 dwYCountChars;
        public UInt32 dwFillAttribute;
        public UInt32 dwFlags;
        public UInt16 wShowWindow;
        public UInt16 cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public UInt32 dwProcessId;
        public UInt32 dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, Int32 infoClass, IntPtr info, UInt32 length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, UInt32 exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        UInt32 creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UInt32 ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(UInt32 desiredAccess, bool inheritHandle, UInt32 processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UInt32 WaitForMultipleObjects(UInt32 count, IntPtr[] handles, bool waitAll, UInt32 milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out UInt32 exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(Int32 standardHandle);

    public static object Probe() {
        bool currentProcessInJob;
        if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out currentProcessInJob)) ThrowLastError("IsProcessInJob");
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLastError("CreateJobObject");
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool assignedProcessInJob = false;
        bool disposableTargetTerminated = false;
        try {
            ConfigureKillOnClose(job);
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (UInt32)Marshal.SizeOf(typeof(STARTUPINFO));
            string executable = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(executable, new string[] { "/d", "/c", "exit", "0" }));
            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero,
                null,
                ref startup,
                out process)) ThrowLastError("CreateProcessW(probe)");
            if (!AssignProcessToJobObject(job, process.hProcess)) ThrowLastError("AssignProcessToJobObject(probe)");
            if (!IsProcessInJob(process.hProcess, job, out assignedProcessInJob)) ThrowLastError("IsProcessInJob(probe)");
            if (!assignedProcessInJob) throw new InvalidOperationException("Disposable probe target was not assigned to the created Job Object.");
            if (!TerminateJobObject(job, 0)) ThrowLastError("TerminateJobObject(probe)");
            disposableTargetTerminated = true;
            return new {
                ok = true,
                currentProcessInJob = currentProcessInJob,
                createJobObject = true,
                setInformationJobObject = true,
                assignProcessToJobObject = true,
                createProcessSuspended = true,
                assignmentAttempted = true,
                assignedProcessInJob = assignedProcessInJob,
                disposableTargetTerminated = disposableTargetTerminated,
                killOnJobClose = true,
                breakawayAllowed = false,
                ownerDeathMonitored = true
            };
        }
        finally {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            CloseHandle(job);
        }
    }

    public static Int32 Run(string executable, string[] arguments, UInt32 ownerPid) {
        if (String.IsNullOrWhiteSpace(executable)) throw new ArgumentException("Executable is required.");

        IntPtr job = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("CreateJobObject");
            ConfigureKillOnClose(job);

            owner = OpenProcess(SYNCHRONIZE, false, ownerPid);
            if (owner == IntPtr.Zero) ThrowLastError("OpenProcess(owner)");

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (UInt32)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);

            StringBuilder commandLine = new StringBuilder(BuildCommandLine(executable, arguments ?? new string[0]));
            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero,
                null,
                ref startup,
                out process)) ThrowLastError("CreateProcessW");
            if (!AssignProcessToJobObject(job, process.hProcess)) ThrowLastError("AssignProcessToJobObject");
            if (ResumeThread(process.hThread) == UInt32.MaxValue) ThrowLastError("ResumeThread");
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;

            IntPtr[] observed = new IntPtr[] { owner, process.hProcess };
            UInt32 wait = WaitForMultipleObjects(2, observed, false, INFINITE);
            if (wait == WAIT_OBJECT_0) {
                TerminateJobObject(job, 143);
                return 143;
            }
            if (wait != WAIT_OBJECT_0 + 1) ThrowLastError("WaitForMultipleObjects");

            UInt32 exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) ThrowLastError("GetExitCodeProcess");
            TerminateJobObject(job, exitCode);
            return unchecked((Int32)exitCode);
        }
        catch {
            if (job != IntPtr.Zero) TerminateJobObject(job, 125);
            throw;
        }
        finally {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (owner != IntPtr.Zero) CloseHandle(owner);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static void ConfigureKillOnClose(IntPtr job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        Int32 size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (UInt32)size)) {
                ThrowLastError("SetInformationJobObject");
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static string BuildCommandLine(string executable, string[] arguments) {
        List<string> values = new List<string>();
        values.Add(QuoteArgument(executable));
        foreach (string argument in arguments) values.Add(QuoteArgument(argument ?? String.Empty));
        return String.Join(" ", values.ToArray());
    }

    private static string QuoteArgument(string value) {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder();
        result.Append('"');
        Int32 backslashes = 0;
        foreach (char character in value) {
            if (character == '\\') {
                backslashes += 1;
            } else if (character == '"') {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
            } else {
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void ThrowLastError(string operation) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
}
'@

if ($Mode -eq 'probe') {
    [MarshalWindowsJobObjectHost]::Probe() | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

$requestText = [Environment]::GetEnvironmentVariable('MARSHAL_JOB_LAUNCH_REQUEST')
if ([string]::IsNullOrWhiteSpace($requestText)) {
    throw 'MARSHAL_JOB_LAUNCH_REQUEST is required.'
}
$request = $requestText | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('MARSHAL_JOB_LAUNCH_REQUEST', $null)
$command = [string] $request.command
$arguments = @($request.arguments | ForEach-Object { [string] $_ })
$exitCode = [MarshalWindowsJobObjectHost]::Run($command, $arguments, [uint32] $OwnerPid)
exit $exitCode
