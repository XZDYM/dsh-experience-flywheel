# probe.ps1 — dsh-experience-flywheel 幂等探针（DESIGN §7）
# 全部在 $env:TEMP\dsh-flywheel-probe\<guid> 临时目录运行，结束自清理。
# 可重复执行、结果稳定、不修改交付物。
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File probe.ps1
# 退出码: 0=全 PASS  1=有 FAIL
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot          # 插件根
$scripts = Join-Path $root "scripts"
$work = Join-Path $env:TEMP ("dsh-flywheel-probe-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$store = Join-Path $work "store"
$logs  = Join-Path $work "logs"
$failed = 0

function Check([string]$label, [bool]$ok, [string]$detail = "") {
    if ($ok) { Write-Host "[PASS] $label" -ForegroundColor Green }
    else { Write-Host "[FAIL] $label $detail" -ForegroundColor Red; $script:failed++ }
}

try {
    # ── 1) plan-gate: 缺验收员 → exit 1; 有 → exit 0; 跑两遍一致 ──
    $planBad = Join-Path $work "plan-bad.md"
    $planGood = Join-Path $work "plan-good.md"
    Set-Content -Path $planBad -Value "# 计划`n只做一件事,没有验收员。" -Encoding UTF8
    Set-Content -Path $planGood -Value "# 计划`n双验收:验收员 A(对照验收)+ 验收员 B(对抗红队),互不知晓结论。" -Encoding UTF8

    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "plan-gate.ps1") -PlanFile $planBad -LogDir $logs | Out-Null
    $c1a = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "plan-gate.ps1") -PlanFile $planBad -LogDir $logs | Out-Null
    $c1b = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "plan-gate.ps1") -PlanFile $planGood -LogDir $logs | Out-Null
    $c2 = $LASTEXITCODE
    Check "plan-gate 缺验收员 exit=1 (两遍 $c1a/$c1b 一致)" ($c1a -eq 1 -and $c1b -eq 1)
    Check "plan-gate 双验收员 exit=0" ($c2 -eq 0)

    # ── 2) verify-claims: 缺文件 exit 1; 存在 exit 0 ──
    $realFile = Join-Path $work "real.txt"
    Set-Content -Path $realFile -Value "hello world" -Encoding UTF8
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "verify-claims.ps1") -Claims (Join-Path $work "missing.txt") -LogDir $logs | Out-Null
    $v1 = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "verify-claims.ps1") -Claims "$realFile;$(Join-Path $work 'missing2.txt')" -LogDir $logs | Out-Null
    $v1b = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "verify-claims.ps1") -Claims "${realFile}:contains=hello" -LogDir $logs | Out-Null
    $v2 = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "verify-claims.ps1") -Claims $realFile -LogDir $logs | Out-Null
    $v2b = $LASTEXITCODE
    Check "verify-claims 缺文件 exit=1 (两遍 $v1/$v1b 一致)" ($v1 -eq 1 -and $v1b -eq 1)
    Check "verify-claims 存在+关键字 exit=0 (两遍 $v2/$v2b 一致)" ($v2 -eq 0 -and $v2b -eq 0)

    # ── 3) ov-remember + ov-search: 沉淀→检索命中; 幂等(两遍同名覆盖) ──
    $probeName = "probe_" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    $content = "【坑】探针测试条目。【根因】无。【对策】探针。【日期】2026-08-16"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "ov-remember.ps1") -Type patterns -Name $probeName -Content $content -StorePath $store -LogDir $logs | Out-Null
    $r1 = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "ov-remember.ps1") -Type patterns -Name $probeName -Content $content -StorePath $store -LogDir $logs | Out-Null
    $r2 = $LASTEXITCODE
    Check "ov-remember 回读验证 exit=0 (两遍 $r1/$r2 一致)" ($r1 -eq 0 -and $r2 -eq 0)

    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "ov-search.ps1") -Query "探针" -StorePath $store -LogDir $logs | Out-Null
    $s1 = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "ov-search.ps1") -Query "探针" -StorePath $store -LogDir $logs | Out-Null
    $s2 = $LASTEXITCODE
    Check "ov-search exit=0 (两遍 $s1/$s2 一致)" ($s1 -eq 0 -and $s2 -eq 0)

    # 检索真的命中了吗? 直接看 cli JSON 输出
    $nodeExe = (Get-Command node).Source
    $hitsJson = & $nodeExe (Join-Path $root "lib\cli.mjs") search "探针" --store $store --top 5 | ConvertFrom-Json
    $hitNames = @($hitsJson.hits | ForEach-Object { $_.name })
    Check "ov-search 真命中探针条目 (含 $probeName)" ($hitNames -contains $probeName) "实际: $($hitNames -join ',')"

    # ── 3b) D1 回归: 中文 bigram 检索命中 (seed 一条中文词, 用词搜) ──
    $cnName = "cn_" + [guid]::NewGuid().ToString("N").Substring(0, 6)
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "ov-remember.ps1") -Type patterns -Name $cnName -Content "【坑】经验库中文检索回归。教训:经验二字必须可检索。【根因】。【对策】。【日期】" -StorePath $store -LogDir $logs | Out-Null
    $cnHits = & $nodeExe (Join-Path $root "lib\cli.mjs") search "经验库" --store $store --top 5 | ConvertFrom-Json
    $cnNames = @($cnHits.hits | ForEach-Object { $_.name })
    Check "D1 中文bigram检索命中 (含 $cnName)" ($cnNames -contains $cnName) "实际: $($cnNames -join ',')"

    # ── 3c) D4 回归: 零声明假绿已修 (;;; 应 exit 2) ──
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "verify-claims.ps1") -Claims ';;;' -LogDir $logs | Out-Null
    Check "D2 零声明 exit=2 (防假绿)" ($LASTEXITCODE -eq 2)

    # ── 4) close-gate: 三全 PASS; 缺飞轮留痕 FAIL ──
    $accFile = Join-Path $work "acceptance.md"
    Set-Content -Path $accFile -Value "验收员 A: PASS(对照验收完成)`n验收员 B: PASS(红队复跑探针完成)" -Encoding UTF8
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "close-gate.ps1") -Acceptance $accFile -LogDir $logs | Out-Null
    $cgOk = $LASTEXITCODE
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts "close-gate.ps1") -Acceptance $accFile -LogDir (Join-Path $work "empty-logs") | Out-Null
    $cgBad = $LASTEXITCODE
    Check "close-gate 三全 exit=0" ($cgOk -eq 0)
    Check "close-gate 缺飞轮留痕 exit=1" ($cgBad -eq 1)
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($failed -eq 0) { Write-Host "`nPROBE ALL PASS" -ForegroundColor Green; exit 0 }
else { Write-Host "`nPROBE FAIL: $failed 项" -ForegroundColor Red; exit 1 }
