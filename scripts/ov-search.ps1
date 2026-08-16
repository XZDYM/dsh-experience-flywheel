# ov-search.ps1 — 查经验（可移植版；逻辑委托 lib/cli.mjs，避免双实现漂移）
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File ov-search.ps1 -Query "关键词" [-Top 5] [-MinScore 0.3]
#        [-StorePath <dir>] [-BaseUrl <openviking>] [-Peer dsh] [-LogDir <dir>]
# 退出码: 0=查询成功(可能 0 命中)  2=查询失败
# 幂等:  只读
param(
    [Parameter(Mandatory = $true)][string]$Query,
    [int]$Top = 5,
    [double]$MinScore = 0.3,
    [string]$StorePath = "",
    [string]$BaseUrl = "",
    [string]$Peer = "dsh",
    [string]$LogDir = ""
)
$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Write-Host "ov-search ERROR: node not found"; exit 2 }
$cli = Join-Path $pluginRoot "lib\cli.mjs"
if (-not $StorePath) { $StorePath = Join-Path $pluginRoot "store" }
if (-not $LogDir) { $LogDir = Join-Path $pluginRoot "logs" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "ov-search.log"
$NowUtc = [DateTimeOffset]::UtcNow

$args = @("$cli", "search", $Query, "--store", $StorePath, "--top", "$Top")
if ($BaseUrl) { $args += @("--url", $BaseUrl) }
if ($Peer) { $args += @("--peer", $Peer) }

$raw = & $nodeExe $args 2>&1
if ($LASTEXITCODE -ne 0) {
    Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  ERROR: $Query" -Encoding UTF8
    Write-Host "ov-search ERROR: $($raw -join ' ')"
    exit 2
}

$hits = @()
try { $hits = @(($raw -join "`n" | ConvertFrom-Json).hits) } catch { $hits = @() }
$hits = @($hits | Where-Object { $_.score -ge $MinScore })

Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  QUERY: $Query -> 命中 $($hits.Count) 条" -Encoding UTF8
Write-Host "=== OpenViking 经验检索: $Query ==="
if ($hits.Count -eq 0) {
    Write-Host "无命中 —— 按新问题处理, 事后必须 ov-remember 沉淀"
    exit 0
}
foreach ($h in $hits) {
    $score = "{0:P0}" -f [double]$h.score
    $head = ($h.abstract -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    Write-Host ""
    Write-Host "[$score] ($($h.type)) $($h.uri)"
    Write-Host "  $head"
}
exit 0
