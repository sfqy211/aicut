param(
    [string]$ProjectDir = "",
    [string]$AsrVenv = "",
    [int]$WindowWidth = 120,
    [int]$WindowHeight = 30
)

$ErrorActionPreference = "Stop"

if (-not $ProjectDir) {
    $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

Write-Host "AICut Development Starter" -ForegroundColor Cyan
Write-Host "Project: $ProjectDir`n"

# 查找 ASR venv
if (-not $AsrVenv) {
    $venvCandidates = @(
        (Join-Path $ProjectDir "services\asr-worker\.venv\Scripts\python.exe"),
        (Join-Path $ProjectDir "services\asr-worker\venv\Scripts\python.exe")
    )
    $AsrVenv = $venvCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $AsrVenv) {
    $AsrVenv = "python"  # fallback to system python
    Write-Host "ASR: Using system python" -ForegroundColor Yellow
} else {
    Write-Host "ASR: Using venv python: $AsrVenv" -ForegroundColor Green
}

# 启动函数
function Start-ServiceWindow {
    param(
        [string]$Title,
        [string]$Command,
        [string]$WorkingDir = $ProjectDir
    )

    $scriptBlock = {
        param($Dir, $Cmd)
        Set-Location $Dir
        Invoke-Expression $Cmd
        Read-Host "Press Enter to close"
    }

    $psArgs = @(
        "-NoExit",
        "-Command",
        "Set-Location '$WorkingDir'; $Command"
    )

    Start-Process -FilePath "powershell.exe" -ArgumentList $psArgs -WindowStyle Normal
    Write-Host "  [$Title] Started" -ForegroundColor Green
}

# 启动 API
Write-Host "`nStarting services..." -ForegroundColor Cyan
Start-ServiceWindow -Title "AICut-API" -Command "pnpm dev:api"

# 启动 Web
Start-ServiceWindow -Title "AICut-Web" -Command "pnpm dev:web"

# 启动 ASR
$asrDir = Join-Path $ProjectDir "services\asr-worker"
$env:AICUT_ASR_ALLOW_STUB = "1"
Start-ServiceWindow -Title "AICut-ASR" -Command "Set-Location '$asrDir'; `$env:AICUT_ASR_ALLOW_STUB='1'; $AsrVenv main.py"

Write-Host "`nAll services started in separate windows." -ForegroundColor Green
Write-Host "  API: http://127.0.0.1:43110"
Write-Host "  Web: http://127.0.0.1:43111"
Write-Host "  ASR: http://127.0.0.1:43112"
