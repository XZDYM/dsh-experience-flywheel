# verify-claims.ps1 — R-04 收尾必落盘校核（可移植版）
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File verify-claims.ps1 `
#          -Claims "path1;path2:contains=kw" -RequireClaims 2 [-LogDir <dir>]
# 格式:  分号分隔多个声明; 每个声明 = <路径>[;:contains=<关键字>]
# 退出码: 0=全部通过  1=存在缺失/关键字不匹配/声明数不足  2=参数错误
# 幂等:  只读不写交付物；仅追加 trace 日志
param(
    [Parameter(Mandatory = $true)][string]$Claims,
    [int]$RequireClaims = 0,
    [string]$LogDir = "",
    [switch]$Quiet
)
$ErrorActionPreference = "Stop"

if (-not $LogDir) { $LogDir = Join-Path (Split-Path -Parent $PSScriptRoot) "logs" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "verify-claims.log"
$NowUtc  = [DateTimeOffset]::UtcNow
function Write-Log($msg) {
    Add-Content -Path $LogFile -Value "$($NowUtc.ToString('yyyy-MM-ddTHH:mm:ssK'))  $msg" -Encoding UTF8
}

$items = @($Claims -split ';' | Where-Object { $_.Trim() })
if ($items.Count -eq 0) {
    Write-Log "FAIL: 声明数为 0 —— 无内容可校核（防假绿）"
    if (-not $Quiet) { Write-Host "FAIL: 声称写入 0 项 —— 空声明即假 PASS, 拒绝（防 D2/D4 假绿）" }
    exit 2
}
if ($items.Count -lt $RequireClaims) {
    Write-Log "FAIL: 声明数 $($items.Count) < 要求 $RequireClaims"
    if (-not $Quiet) { Write-Host "FAIL: 声称写入 $($items.Count) 项, 少于要求的 $RequireClaims —— 交付不完整" }
    exit 1
}

$failed = 0
Write-Log "===== R-04 收尾校核 ($($items.Count) 项声明) ====="
foreach ($raw in $items) {
    $path = $raw; $needle = ""
    if ($raw -match '^(.*?):contains=(.*)$') { $path = $Matches[1].Trim(); $needle = $Matches[2] }
    if (-not (Test-Path -LiteralPath $path)) {
        $failed++
        Write-Log "MISS: $raw"
        if (-not $Quiet) { Write-Host "MISS  $raw" }
        continue
    }
    if ($needle) {
        $content = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($content -and $content.Contains($needle)) {
            Write-Log "OK  : $path (contains: $needle)"
            if (-not $Quiet) { Write-Host "OK   $path [含关键字] $needle" }
        } else {
            $failed++
            Write-Log "MISS: $path (关键字未命中: $needle)"
            if (-not $Quiet) { Write-Host "MISS $path [关键字未命中: $needle]" }
        }
    } else {
        Write-Log "OK  : $path"
        if (-not $Quiet) { Write-Host "OK   $path" }
    }
}
if ($failed -gt 0) {
    Write-Log "===== 校核结束: FAIL ($failed/$($items.Count) 项缺失) ====="
    if (-not $Quiet) { Write-Host "`nR-04 校核 FAIL: $failed/$($items.Count) 项声称写入未验证通过 —— 禁止交付" }
    exit 1
} else {
    Write-Log "===== 校核结束: PASS ($($items.Count) 项全部验证通过) ====="
    if (-not $Quiet) { Write-Host "`nR-04 校核 PASS: $($items.Count) 项声称写入全部验证通过" }
    exit 0
}
