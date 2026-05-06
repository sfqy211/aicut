param(
    [string]$ProjectDir = "",
    [switch]$SkipCleanup
)

$ErrorActionPreference = "Stop"

if (-not $ProjectDir) {
    $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

Write-Host "AICut Development Starter" -ForegroundColor Cyan
Write-Host "Project: $ProjectDir`n"

# 清理残留端口进程
if (-not $SkipCleanup) {
    Write-Host "Checking for existing processes on ports..." -ForegroundColor Yellow
    $ports = @(43110, 43111)
    foreach ($port in $ports) {
        $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if ($conn) {
            $processId = $conn.OwningProcess
            Write-Host "  Killing process $processId on port $port" -ForegroundColor Yellow
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 500
}

# 启动函数
function Start-ServiceWindow {
    param(
        [string]$Title,
        [string]$Command,
        [string]$WorkingDir = $ProjectDir
    )

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

Start-Sleep -Milliseconds 300

# 启动 Web
Start-ServiceWindow -Title "AICut-Web" -Command "pnpm dev:web"

Write-Host "`nAll services started in separate windows." -ForegroundColor Green
Write-Host "  API:    http://127.0.0.1:43110" -ForegroundColor White
Write-Host "  Web:    http://127.0.0.1:43111" -ForegroundColor White
