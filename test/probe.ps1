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

    # ── 3d) F2 回归: claims 治理纯函数（上限/TTL/PASS 移除/幂等）──
    # 直接 node 跑 lib/claims.js，不装 harness；两遍结果一致。
    $claimsNode = Join-Path $work "claims-probe.mjs"
    @"
import { createClaims, addClaim, pruneClaims, listClaims, removeClaims, claimsSize } from "file:///$(($root -replace '\\','/'))/lib/claims.js";
let fails = 0;
const ck = (label, ok) => { if (!ok) { console.error("CLAIMS-FAIL: " + label); fails++; } };

// 1) 上限淘汰最旧
const c1 = createClaims({ max: 3, ttlMs: 60000 });
addClaim(c1, "a"); addClaim(c1, "b"); addClaim(c1, "c"); addClaim(c1, "d");
ck("cap evicts oldest (size=3, got " + claimsSize(c1) + ")", claimsSize(c1) === 3);
ck("cap keeps newest (b,c,d)", JSON.stringify(listClaims(c1)) === JSON.stringify(["b","c","d"]));

// 2) TTL 过期清理
const c2 = createClaims({ max: 50, ttlMs: 1000 });
addClaim(c2, "old", Date.now() - 5000);
addClaim(c2, "fresh");
const pruned = pruneClaims(c2);
ck("ttl prunes stale (pruned=" + pruned + ")", pruned === 1);
ck("ttl keeps fresh", claimsSize(c2) === 1 && listClaims(c2)[0] === "fresh");

// 3) PASS 后移除已验证路径
const c3 = createClaims({ max: 50, ttlMs: 60000 });
addClaim(c3, "x"); addClaim(c3, "y");
removeClaims(c3, ["x"]);
ck("remove verified path", claimsSize(c3) === 1 && listClaims(c3)[0] === "y");

// 4) 幂等: 重复 add 同路径不膨胀
const c4 = createClaims({ max: 50, ttlMs: 60000 });
addClaim(c4, "p"); addClaim(c4, "p"); addClaim(c4, "p");
ck("re-add same path idempotent (size=1, got " + claimsSize(c4) + ")", claimsSize(c4) === 1);

if (fails === 0) { console.log("CLAIMS ALL PASS"); process.exit(0); }
process.exit(1);
"@ | Set-Content -Path $claimsNode -Encoding UTF8
    & $nodeExe $claimsNode
    $f2a = $LASTEXITCODE
    & $nodeExe $claimsNode
    $f2b = $LASTEXITCODE
    Check "F2 claims 治理 4 项单测 exit=0 (两遍 $f2a/$f2b 一致)" ($f2a -eq 0 -and $f2b -eq 0)

    # ── 3e) F3 回归: extractClaimedPaths 工具名白名单 + 形状校验 ──
    # dogfood 真坑: browser_click target=f1e84 被误收成文件路径 → verify 假阳性。
    $claimsNode3e = Join-Path $work "claims-extract-probe.mjs"
    @"
import { extractClaimedPaths } from "file:///$(($root -replace '\\','/'))/lib/claims.js";
let fails = 0;
const ck = (label, ok) => { if (!ok) { console.error("EXTRACT-FAIL: " + label); fails++; } };
const j = (a) => JSON.stringify(a);

// 1) 非写盘工具（Playwright 等）→ 一律不收，即使有 target/source
ck("browser_click target=ref rejected", j(extractClaimedPaths({ name: "browser_click", arguments: { target: "f1e84" } })) === "[]");
ck("browser_type path-looking arg rejected (tool gate)", j(extractClaimedPaths({ name: "browser_type", arguments: { target: "C:\\x.md" } })) === "[]");

// 2) 写盘工具 + 明确路径 key → 收
ck("edit file_path collected", j(extractClaimedPaths({ name: "edit", arguments: { file_path: "F:\\a.md" } })) === j(["F:\\a.md"]));
ck("mcp__filesystem__write_file path collected", j(extractClaimedPaths({ name: "mcp__filesystem__write_file", arguments: { path: "F:\\b.txt" } })) === j(["F:\\b.txt"]));

// 3) 写盘工具 + 模糊 key(target/source) → 形状校验: 真路径收, ref 不收
//    (结果按 PATH_KEYS 顺序输出, 顺序无意义 → 排序后比较)
const s = (a) => j([...a].sort());
ck("move source real path collected", s(extractClaimedPaths({ name: "mcp__filesystem__move_file", arguments: { source: "F:\\src.md", destination: "F:\\dst.md" } })) === s(["F:\\src.md", "F:\\dst.md"]));
ck("move target ref rejected", j(extractClaimedPaths({ name: "move_file", arguments: { target: "f1e84" } })) === "[]");
ck("write target ref rejected", j(extractClaimedPaths({ name: "write", arguments: { target: "f1e107" } })) === "[]");
ck("write relative ./x.md collected", j(extractClaimedPaths({ name: "write", arguments: { path: "./x.md" } })) === j(["./x.md"]));

// 4) 无参数/空 → 空
ck("empty exec rejected", j(extractClaimedPaths({ name: "edit", arguments: {} })) === "[]");

if (fails === 0) { console.log("EXTRACT ALL PASS"); process.exit(0); }
process.exit(1);
"@ | Set-Content -Path $claimsNode3e -Encoding UTF8
    & $nodeExe $claimsNode3e
    $f3a = $LASTEXITCODE
    & $nodeExe $claimsNode3e
    $f3b = $LASTEXITCODE
    Check "F3 extractClaimedPaths 8 项单测 exit=0 (两遍 $f3a/$f3b 一致)" ($f3a -eq 0 -and $f3b -eq 0)

    # ── 3f) F1 回归: search 词边界加权（噪声降权/独立词优先/recall 保持/幂等）──
    $f1Node = Join-Path $work "f1-search-probe.mjs"
    @"
import { MarkdownStore, tokenize } from "file:///$(($root -replace '\\','/'))/lib/store.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
let fails = 0;
const ck = (label, ok) => { if (!ok) { console.error("F1-FAIL: " + label); fails++; } };

const d = await mkdtemp(join(tmpdir(), "f1-"));
await mkdir(join(d, "patterns"));
// noise: 只有"经验库"(嵌入), 无独立"经验"
await writeFile(join(d, "patterns", "mem_noise.md"), "【坑】经验库中文检索回归。教训:经验二字必须可检索。", "utf8");
// precise: 独立"经验"
await writeFile(join(d, "patterns", "mem_precise.md"), "【坑】经验 必须 主动 沉淀。", "utf8");
const s = new MarkdownStore(d);

// 1) tokenize 契约不变
ck("tokenize 经验 -> [经验]", JSON.stringify(tokenize("经验")) === JSON.stringify(["经验"]));
ck("tokenize 经验库 -> [经验,验库]", JSON.stringify(tokenize("经验库")) === JSON.stringify(["经验","验库"]));

// 2) 查"经验": 独立词文档 score=1.0 排第一; 噪声文档降权 < 1.0 但仍在结果(recall 保持)
//    (store 的 name 已剥 mem_ 前缀 → 断言用 precise/noise)
const r1 = await s.search("经验", 5);
ck("precise 排第一 (got " + (r1[0]?.name ?? "none") + ")", r1[0]?.name === "precise");
ck("precise score=1.0 (got " + r1[0]?.score + ")", r1[0]?.score === 1);
ck("noise 降权 < 0.5 (got " + (r1[1]?.score ?? "none") + ")", r1[1]?.name === "noise" && r1[1].score < 0.5);
ck("noise 仍在结果 (recall 保持, n=" + r1.length + ")", r1.length === 2);

// 3) 查"经验库": 两篇都命中(recall), 排序不崩
const r2 = await s.search("经验库", 5);
ck("经验库 双命中 (n=" + r2.length + ")", r2.length === 2);

// 4) ascii 词边界: "plugin" 不因 "plugins" 误配满分
const d2 = join(d, "patterns");
await writeFile(join(d2, "mem_plugin.md"), "the dsh-plugin ecosystem", "utf8");
await writeFile(join(d2, "mem_plugins.md"), "plugins are separate", "utf8");
const r3 = await s.search("plugin", 5);
ck("plugin 独立词排第一 (got " + (r3[0]?.name ?? "none") + ")", r3[0]?.name === "plugin");

if (fails === 0) { console.log("F1 SEARCH ALL PASS"); process.exit(0); }
process.exit(1);
"@ | Set-Content -Path $f1Node -Encoding UTF8
    & $nodeExe $f1Node
    $f1a = $LASTEXITCODE
    & $nodeExe $f1Node
    $f1b = $LASTEXITCODE
    Check "F1 search 词边界加权 8 项单测 exit=0 (两遍 $f1a/$f1b 一致)" ($f1a -eq 0 -and $f1b -eq 0)

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
