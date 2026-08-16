# close-gate.ps1 — R-01 收官阶段闸门（可移植版）
# 验收留痕(双验收员都 PASS) + 飞轮留痕(查过经验 + 沉淀过经验) + 收尾校核，三全才放行。
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File close-gate.ps1 `
#          [-Acceptance <验收记录文件>] [-Claims "<路径;路径:contains=kw>"] [-RequireClaims <N>] [-LogDir <dir>]
# 退出码: 0=PASS(三全)  1=FAIL(任一缺)  2=参数/文件错误
# 幂等:  只读
param(
    [string]$Acceptance = "",
    [string]$Claims = "",
    [int]$RequireClaims = 0,
    [string]$LogDir = ""
)
$ErrorActionPreference = "Stop"

if (-not $LogDir) { $LogDir = Join-Path (Split-Path -Parent $PSScriptRoot) "logs" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "team-close-gate.log"
$NowUtc  = [DateTimeOffset]::UtcNow
function Write-Log($msg) {
    Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  $msg" -Encoding UTF8
}

$problems = @()

# ── 1) 双验收留痕 ──────────────────────────────────────────────
$accOk = $false
if ($Acceptance -and (Test-Path -LiteralPath $Acceptance)) {
    $a = Get-Content -LiteralPath $Acceptance -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    # 双 PASS：两个独立验收员结论都存在且为 PASS（允许 "A: PASS" "B: PASS" 或 "PASS"×2）
    $passCount = ([regex]::Matches($a, '(?i)PASS')).Count
    $hasA = $a -match '验收员\s*A|verifier\s*A|验收员.?A|对照'
    $hasB = $a -match '验收员\s*B|verifier\s*B|红队|red\s*team|对抗'
    if ($passCount -ge 2 -and $hasA -and $hasB) { $accOk = $true }
}
if (-not $accOk) { $problems += "双验收留痕缺失或未双 PASS（需记录文件含 A、B 两个验收员结论且各 PASS）" }

# ── 2) 飞轮留痕 ───────────────────────────────────────────────
$searchLog = Join-Path $LogDir "ov-search.log"
$rememberLog = Join-Path $LogDir "ov-remember.log"
$searchOk = (Test-Path $searchLog) -and ((Get-Content $searchLog -Raw -ErrorAction SilentlyContinue).Trim().Length -gt 0)
$rememberOk = (Test-Path $rememberLog) -and ((Get-Content $rememberLog -Raw -ErrorAction SilentlyContinue).Trim().Length -gt 0)
if (-not $searchOk) { $problems += "飞轮留痕缺失: ov-search.log 为空或不存在（任务开始应查过经验）" }
if (-not $rememberOk) { $problems += "飞轮留痕缺失: ov-remember.log 为空或不存在（任务收尾应沉淀过经验）" }

# ── 3) 收尾校核 ───────────────────────────────────────────────
if ($Claims) {
    $items = @($Claims -split ';' | Where-Object { $_.Trim() })
    if ($items.Count -lt $RequireClaims) {
        $problems += "声称写入 $($items.Count) 项, 少于要求的 $RequireClaims"
    } else {
        foreach ($raw in $items) {
            $path = $raw; $needle = ""
            if ($raw -match '^(.*?):contains=(.*)$') { $path = $Matches[1].Trim(); $needle = $Matches[2] }
            if (-not (Test-Path -LiteralPath $path)) { $problems += "声称写入不存在: $raw"; continue }
            if ($needle) {
                $c = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
                if (-not ($c -and $c.Contains($needle))) { $problems += "关键字未命中: $raw" }
            }
        }
    }
}

Write-Log "close-gate: acceptance=$accOk flywheel=$($searchOk -and $rememberOk) claims=$(if($Claims){'checked'}else{'n/a'}) problems=$($problems.Count)"
if ($problems.Count -eq 0) {
    Write-Host "close-gate PASS: 双验收留痕 + 飞轮留痕 + 收尾校核 三全"
    exit 0
} else {
    Write-Host "close-gate FAIL:"
    foreach ($p in $problems) { Write-Host "  - $p" }
    exit 1
}
