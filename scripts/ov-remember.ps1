# ov-remember.ps1 — 沉淀经验（可移植版；逻辑委托 lib/cli.mjs，回读验证命中才 exit 0）
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File ov-remember.ps1 `
#          -Type patterns -Name mem_xxx -Content "【坑】…【根因】…【对策】…" [-StorePath <dir>] [-BaseUrl <url>] [-Peer dsh] [-LogDir <dir>]
# 退出码: 0=写入且回读验证通过  3=写入后回读未命中  2=失败/参数错
# 幂等:  同名覆盖, 内容相同则无副作用
param(
    [Parameter(Mandatory = $true)][string]$Type,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Content,
    [string]$StorePath = "",
    [string]$BaseUrl = "",
    [string]$Peer = "dsh",
    [string]$LogDir = ""
)
$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Write-Host "ov-remember ERROR: node not found"; exit 2 }
$cli = Join-Path $pluginRoot "lib\cli.mjs"
if (-not $StorePath) { $StorePath = Join-Path $pluginRoot "store" }
if (-not $LogDir) { $LogDir = Join-Path $pluginRoot "logs" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "ov-remember.log"
$NowUtc = [DateTimeOffset]::UtcNow

$args = @("$cli", "remember", $Type, $Name, $Content, "--store", $StorePath)
if ($BaseUrl) { $args += @("--url", $BaseUrl) }
if ($Peer) { $args += @("--peer", $Peer) }

$raw = & $nodeExe $args 2>&1
$code = $LASTEXITCODE

if ($code -eq 0) {
    $uri = (($raw -join "`n") | ConvertFrom-Json).uri
    Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  WRITE OK + VERIFY OK: $uri" -Encoding UTF8
    Write-Host "已写入: $uri"
    Write-Host "回读验证通过: 检索命中"
    exit 0
} elseif ($code -eq 3) {
    Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  WRITE OK + VERIFY MISS: $Type/$Name" -Encoding UTF8
    Write-Host "已写入但回读未命中: $Type/$Name —— 需人工检查"
    exit 3
} else {
    Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  ERROR: $Type/$Name -> $($raw -join ' ')" -Encoding UTF8
    Write-Host "ov-remember ERROR: $($raw -join ' ')"
    exit 2
}
