# plan-gate.ps1 — R-01 编制阶段闸门（可移植版）
# 计划文件必须声明两个互相独立的对抗性验收员:
#   A = 对照验收（对照需求逐条核对交付物）  B = 红队（独立复跑探针、找幻觉/证据缺口）
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File plan-gate.ps1 -PlanFile <path> [-LogDir <dir>]
# 退出码: 0=PASS(双验收员已声明)  1=FAIL(缺失)  2=参数错误/文件不存在
# 幂等:  只读计划文件
param(
    [Parameter(Mandatory = $true)][string]$PlanFile,
    [string]$LogDir = ""
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PlanFile)) {
    Write-Host "plan-gate FAIL: 计划文件不存在: $PlanFile"
    exit 2
}
if (-not $LogDir) { $LogDir = Join-Path (Split-Path -Parent $PSScriptRoot) "logs" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "team-plan-gate.log"
$NowUtc  = [DateTimeOffset]::UtcNow
function Write-Log($msg) {
    Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  $msg" -Encoding UTF8
}

$text = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 -ErrorAction Stop

# 验收员 A：对照（reference / 对照 / verifier A / 验收员A）
$aOk = $text -match '验收员\s*A|验收员\s*A[:：]|verifier\s*A|reference\s*verif|对照验收|验收员.?A'
# 验收员 B：红队（red team / 红队 / verifier B / 验收员B）
$bOk = $text -match '验收员\s*B|验收员\s*B[:：]|verifier\s*B|red\s*team|红队|对抗'

Write-Log "plan-gate: $PlanFile -> A=$aOk B=$bOk"
if ($aOk -and $bOk) {
    Write-Host "plan-gate PASS: 计划声明了双独立验收员（A 对照 + B 红队）"
    exit 0
} else {
    Write-Host "plan-gate FAIL: 计划未完整声明双独立验收员"
    if (-not $aOk) { Write-Host "  缺失: 验收员 A（对照验收）" }
    if (-not $bOk) { Write-Host "  缺失: 验收员 B（对抗红队）" }
    exit 1
}
