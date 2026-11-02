[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 3)]
    [int]$QuestionNumber,

    [string]$RunId = (Get-Date -Format 'yyyyMMdd-HHmmss'),

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$demoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $demoRoot 'run-treatment.ps1'
$workspace = 'Q:\src\.marshal-worktrees\quillstone-demo-runtime-03aafbe'

$arguments = @(
    '-F',
    '-w', 'new',
    'new-tab',
    '--title', 'CODEX-ONLY',
    '-d', $workspace,
    'pwsh', '-NoLogo', '-NoExit', '-File', $runner,
    '-Treatment', 'control', '-QuestionNumber', $QuestionNumber, '-RunId', $RunId,
    ';',
    'split-pane', '-V',
    '--title', 'MARSHAL-BRAIN',
    '-d', $workspace,
    'pwsh', '-NoLogo', '-NoExit', '-File', $runner,
    '-Treatment', 'brain', '-QuestionNumber', $QuestionNumber, '-RunId', $RunId
)

if ($DryRun) {
    [ordered]@{
        executable = (Get-Command wt.exe).Source
        arguments = $arguments
        runId = $RunId
        questionNumber = $QuestionNumber
    } | ConvertTo-Json -Depth 4
    exit 0
}

Start-Process -FilePath (Get-Command wt.exe).Source -ArgumentList $arguments | Out-Null
Write-Output $RunId

