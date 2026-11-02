[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('control', 'brain')]
    [string]$Treatment,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 3)]
    [int]$QuestionNumber,

    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

$demoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$questions = (Get-Content -Raw (Join-Path $demoRoot 'questions.json') | ConvertFrom-Json).questions
$question = [string]$questions[$QuestionNumber - 1]
$workspace = 'Q:\src\.marshal-worktrees\quillstone-demo-runtime-03aafbe'
$codex = 'C:\Users\omerm\AppData\Local\OpenAI\Codex\bin\8fffe69425752027\codex.exe'
$profile = if ($Treatment -eq 'brain') { 'marshal-brain-demo' } else { 'marshal-control-demo' }
$label = if ($Treatment -eq 'brain') { 'MARSHAL + BRAIN + QUILLSTONE' } else { 'CODEX ONLY - MARSHAL DISABLED' }
$runRoot = "Q:\marshal-demo\codex-brain-comparison\runs\$RunId"
$logPath = Join-Path $runRoot ("q$QuestionNumber-$Treatment.log")
$donePath = Join-Path $runRoot ("q$QuestionNumber-$Treatment.done.json")

New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

if (-not $NonInteractive) {
    Clear-Host
}
Write-Host ('=' * 78) -ForegroundColor DarkGray
Write-Host $label -ForegroundColor $(if ($Treatment -eq 'brain') { 'Cyan' } else { 'Yellow' })
Write-Host 'Model: gpt-5.6-terra | Reasoning: low | Sandbox: read-only' -ForegroundColor Gray
Write-Host ("Workspace: $workspace") -ForegroundColor Gray
Write-Host ("Question: $QuestionNumber of 3") -ForegroundColor Gray
Write-Host ('=' * 78) -ForegroundColor DarkGray
Write-Host ''
Write-Host $question -ForegroundColor White
Write-Host ''
Write-Host 'Timer starts now.' -ForegroundColor Green

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$codexArgs = @(
    '-p', $profile,
    'exec',
    '--model', 'gpt-5.6-terra',
    '--cd', $workspace,
    '--sandbox', 'read-only',
    '--color', 'always',
    $question
)

& $codex @codexArgs 2>&1 | Tee-Object -FilePath $logPath
$exitCode = $LASTEXITCODE
$stopwatch.Stop()

$result = [ordered]@{
    treatment = $Treatment
    profile = $profile
    questionNumber = $QuestionNumber
    elapsedMilliseconds = $stopwatch.ElapsedMilliseconds
    elapsed = $stopwatch.Elapsed.ToString()
    exitCode = $exitCode
    completedAt = [DateTimeOffset]::UtcNow.ToString('O')
    logPath = $logPath
}
$result | ConvertTo-Json | Set-Content -Encoding utf8 $donePath

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor DarkGray
Write-Host ("FINISHED in {0:n1} seconds (exit {1})" -f $stopwatch.Elapsed.TotalSeconds, $exitCode) -ForegroundColor Green
Write-Host ("Transcript: $logPath") -ForegroundColor Gray
Write-Host ('=' * 78) -ForegroundColor DarkGray
Write-Host 'Leave this pane open while the final frame is recorded.' -ForegroundColor DarkGray

if (-not $NonInteractive) {
    Read-Host 'Press Enter to close this pane' | Out-Null
}
