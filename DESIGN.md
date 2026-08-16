# dsh-experience-flywheel — 设计文档（WIP）

> DSH 经验飞轮插件 · 给纯文本 agent 装"上一回记得这个坑"的肌肉记忆。
> 把老李（@laoli）私有 AGENTS.md 里的 **R-02 经验飞轮** + **R-01 双验收闸门** 机制内核，
> 脱耦成任何人 `dsh plugin add github:<owner>/dsh-experience-flywheel` 即装的通用 dsh.bundle 插件。

---

## 0. 一句话目标

让 agent **不靠自觉**就能：① 每轮动手前自动查经验把命中注入上下文；② 每次写完文件自动校核"声称写了"是否真写了；③ 闸门脚本（exit 1）的判定回灌成阻塞指令。
真"内核级 veto（exit 1 直接阻止输出）" rc.6 接缝不支持，降级为"软硬"（见 §9）。

## 1. 形态裁决（摸查已钉死，非估）

| 需求 | DSH rc.6 接缝 | 实测证据 | 可行性 |
|---|---|---|---|
| dsh.bundle 插件 | `package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml` | dsh-web-app 包即此形态 | ✅ |
| 安装 | `dsh plugin --profile web add <pkg>`（可 github:URL） | whale-girl 文档 `github:dsh-external/whale-girl#<ref>&path:/.dsh-plugin` | ✅ |
| **自动**查经验注入 | `ctx.on("agent/pre-step", ({agent, messages}, next)=>...)` 中间件 | `dsh-repeat-tool-reminder/lib/index.js:317` | ✅ |
| 工具后自动校核 | `ctx.on("tools/post-execute", (exec, result, next)=>...)` | `dsh-repeat-tool-reminder/lib/index.js:303` | ✅ |
| 注入纪律文本 | `agent-instructions` 接缝（AGENTS.md 自动加载） | `dsh-base/cordis.patch.yml` agent-instructions 行 | ✅ |
| slash 命令 | `commands` 接缝 | dsh-commands/dsh-command-feedback | ✅ |
| 工具注册 | `tools` 接缝 | dsh-tools | ✅ |
| **真·硬拦下交付** | 中间件能改 messages，但 listener 抛错只 `warn` 不中止 | `dsh-agent-loop/lib/index.js:1040-1044` catch+warn | ⚠️ 降级（软硬） |

## 2. 仓库结构

```
dsh-experience-flywheel/
├─ package.json            # main: lib/index.js; dsh.bundle.patch: ./cordis.patch.yml
├─ cordis.patch.yml        # 插件 patch：insert 我们的服务 + 命令
├─ lib/
│  ├─ index.js             # 服务主入口：注册 pre-step / post-execute 中间件 + 命令 + 工具
│  ├─ store.js             # 后端抽象：markdown-folder（默认）/ openviking（可选）
│  ├─ gates.js             # 闸门脚本运行器（spawn powershell，吃 exit code）
│  ├─ claims.js            # F2 claims 治理：上限 / TTL / PASS 后移除（纯函数，可单测）
│  └─ search.js            # 经验查询/回读（后端无关）
├─ scripts/                # 可移植闸门脚本（exit-1 的确定性真相，零依赖，PowerShell）
│  ├─ ov-search.ps1        # 查经验（markdown 全文/可选 OV 向量）
│  ├─ ov-remember.ps1      # 沉淀经验（写文件，回读校验命中才 exit 0）
│  ├─ plan-gate.ps1        # 编制闸门：计划未声明双验收员 → exit 1
│  ├─ close-gate.ps1       # 收官闸门：双验收留痕 + 校核任一缺 → exit 1
│  └─ verify-claims.ps1    # 收尾校核：声称写入的文件真存在 → exit 0/1
├─ store/                  # 默认本地经验库（markdown）
│  └─ patterns/            # 经验条目（mem_*.md）
├─ SKILL.md                # 飞轮协议（通用版，去老李私货）
├─ README.md               # 双语标题：dsh-experience-flywheel · DSH 经验飞轮插件
├─ DESIGN.md               # 本文件
└─ test/
   └─ probe.ps1            # 幂等探针（不修改交付物，可重复跑）
```

## 3. 运行时行为

### 3.1 agent/pre-step（自动查经验，R-02 step1 自动化）
每次模型要发言前，中间件：
1. 取最近一条 user 消息文本 → 抽关键词（去停用词、取名词/动词 top-5）。
2. 调 `scripts/ov-search.ps1 "<关键词>"`（markdown 全文检索；配置了 OPENVIKING_URL 则走向量）。
3. 命中条目 → 拼成 system 消息 `unshift` 进 `messages`：`【经验】score/摘要首行…`。
4. 无命中 → 注入提醒"这是新问题，处理完务必 ov-remember 沉淀"。
5. `next()` 放行。
**模型无关、服务端自动**——这就是"连按闸门都自动化"的核心。留痕 → `logs/ov-search.log`。

### 3.2 tools/post-execute（自动校核，R-04 自动化）
文件类工具（edit/write/pwsh 写盘）执行后：
1. 解析被写路径（从工具 args）→ 累进"声称写入"清单。
2. 关键节点（goal complete / 用户说"交付"）触发 `scripts/verify-claims.ps1`。
3. exit 1 → 注入阻塞指令"以下文件声称写了但不存在，禁止交付，补写"。
**软硬**：脚本真跑真出 exit code；注入的是指令不是 kernel veto。

### 3.3 slash 命令（人/模型都可调）
- `/flywheel-search <关键词>` → ov-search.ps1
- `/flywheel-remember <类型> <名> <内容>` → ov-remember.ps1（回读校验命中才 exit 0）
- `/plan-gate <计划文件>` → plan-gate.ps1（未声明双验收员 exit 1）
- `/close-gate` → close-gate.ps1
- `/verify <路径;...>` → verify-claims.ps1
命令把 exit code 回灌成 system 提示，模型可见、轨迹可审计。

## 4. 脱耦清单（去掉老李的私货，才装得给别人）

| 私货（不带） | 通用替代 |
|---|---|
| OpenViking 硬绑 | `store.js` 抽象；默认 markdown 文件夹；`OPENVIKING_URL` 配了才升级向量 |
| F:\DeepSeekHarness 硬路径 | 全走 config（storePath 默认 `./store`） |
| 保定/设计院/WorkBuddy 红线（R-03） | 不带；SKILL.md 只留飞轮协议内核 |
| 老李个人画像 | 不带 |
| AGENTS.md 个人规矩 | 本插件**不写死规矩**；附 `examples/agents.md.fragment` 供用户自愿贴 |

## 5. 后端抽象（store.js）

```
interface Store {
  search(query, topK): Hit[]      // 查
  remember(type, name, content): {uri, verified}   // 写 + 回读校验
}
class MarkdownStore  // ./store/<type>/<name>.md，grep -i 全文；零依赖
class OpenVikingStore // POST /api/v1/search/search；remember 走 content/write
// 启动时按 config.backend 选；OPENVIKING_URL 非空 → OpenViking，否则 markdown
```

## 6. 闸门脚本契约（确定性 exit code，幂等）

| 脚本 | exit 0 | exit 1 | 幂等 |
|---|---|---|---|
| plan-gate.ps1 | 计划声明了 2 个独立验收员（A 对照 + B 红队） | 缺 | ✅ 只读计划文件 |
| close-gate.ps1 | 双验收留痕 + 飞轮留痕 + 校核三全 | 任一缺 | ✅ 只读日志 |
| verify-claims.ps1 | 声称文件全存在（可选关键字命中） | 有缺 | ✅ 只读 |
| ov-remember.ps1 | 写入并回读命中 | 回读未命中 exit 3 | ✅ 同名覆盖 |
| ov-search.ps1 | 正常查（命中数任意） | 查询失败 exit 2 | ✅ 只读 |

## 7. 测试 / 验收计划（幂等探针不能少）

`test/probe.ps1`（只读、可重复、不动交付物，当前 12 项全 PASS，全两遍一致）：
1. plan-gate：喂"缺验收员"的计划文件 → 期望 exit 1；喂"有验收员"→ 期望 exit 0。跑两遍结果一致。
2. verify-claims：声称一个不存在文件 → exit 1；声称真实存在 → exit 0。两遍一致。
3. ov-remember + ov-search：remember 一条 → search 应命中同名。两遍（第二次同名覆盖）不产生副作用。
4. D1/D2 回归：中文 bigram 检索命中；零声明（`;;;`）exit 2 防假绿。
5. F2 回归：claims.js 纯函数单测——上限淘汰最旧 / TTL 清理过期 / PASS 移除已验证 / 重复 add 幂等。两遍一致。
6. F3 回归：extractClaimedPaths 单测——非写盘工具拒绝 / 明确 key 收 / 模糊 key 形状校验 / 空参拒绝。两遍一致。
7. F1 回归：search 词边界加权单测——tokenize 契约 / 独立词排第一 / 噪声降权 / recall 保持 / ASCII 词边界。两遍一致。
8. close-gate：三全 PASS；缺飞轮留痕 FAIL。
9. store 抽象：markdown 后端 search/remember 闭环；OpenViking 后端（若有 URL）同样。
10. 真实安装探针：在干净临时 profile 里 `dsh plugin add` 本目录 → 启动 → pre-step 注入 system 消息出现。

交付前：`verify-claims.ps1` 校核所有声称产物存在；双验收 subagent（A 对照 + B 红队）独立复跑探针。

## 8. 软硬边界诚实声明

- ✅ 可自动化：查经验注入、工具后校核、闸门 exit-1 回灌成阻塞指令。
- ⚠️ 不可（rc.6）：listener 抛错只 warn 不中止轮次 → **真 exit-1 阻止输出给用户** 做不到。
- 缓解：闸门 exit 1 → 注入硬指令 + 轨迹可见标记，模型越过门才交付。
- future：harness 加 "message-outgoing veto" 接缝后，升 `close-gate` 为真硬。

## 9. 发布步骤（你这位门外汉照做）

1. 在 GitHub 建空仓库 `dsh-experience-flywheel`（ASCII 名）。
2. `cd F:\DeepSeekHarness\plugins\dsh-experience-flywheel` → `git init && git add . && git commit`。
3. `git remote add origin https://github.com/<你>/dsh-experience-flywheel.git && git push`。
4. 打 topic：仓库页 → Topics 加 `dsh-plugin`（进生态被发现）。
5. README 标题写双语：`dsh-experience-flywheel · DSH 经验飞轮插件`。
6. 别人装：`dsh plugin --profile web add github:<你>/dsh-experience-flywheel` → 重启。

## 10. 进度

- [x] 摸查接缝、裁决形态、沉淀经验（mem_dsh_20260816_plugin_seams_pre_step）
- [x] 骨架：package.json / cordis.patch.yml / README / SKILL
- [x] lib/index.js + store.js + search.js + gates.js + cli.mjs（store 双后端 name 统一剥 mem_ 前缀）
- [x] scripts/*.ps1（5 个，UTF-8 BOM 必带——PS5.1 无 BOM 按 ANSI 读中文会炸）
- [x] test/probe.ps1 幂等探针（12/12 PASS，全两遍一致）
- [x] 真实安装探针：临时 profile flywheel-probe + headless + 审计日志验证 INJECT + 模型遵循注入 ✅
- [x] 沉淀安装探针抓到的坑（mem_dsh_20260816_plugin_prestep_messages_contract）
- [x] 双验收：第1轮 A=PASS/B=FAIL(§11 抓 5 问题) → 返工修复 → 第2轮 **A=PASS/B=PASS 双 PASS**
- [x] 合成/分解谬误自检（§11，红队专跑，C1-C6/D1-D4 全 PASS）
- [x] team-close-gate + 插件 close-gate 双 PASS + verify-claims PASS
- [x] git push + topic dsh-plugin（已发布 v0.1.0，commit 37a0307）
- [x] **F2 claims 治理**（2026-08-16 收尾迭代）：lib/claims.js 纯函数 + index.js 接入 + 探针 §3d 单测 4 项 → 12/12 PASS，已随 v0.1.0+ 提交
- [x] **F3 claimed-paths 假阳性修复**（2026-08-16 dogfood 迭代）：extractClaimedPaths 工具名白名单 + 形状校验 + 探针 §3e 单测 8 项 → 13/13 PASS
- [x] **F1 搜索去噪**（2026-08-16 dogfood 迭代）：store.js 词边界加权打分（strong=1.0 / weak=0.3，recall 保持）+ 探针 §3f 单测 8 项 → 14/14 PASS
- [x] **F4 session-safety message-id factory**（2026-08-16 会话损坏根因修）：本地工厂块 MessageId/deepFreeze/freezeMessage/createMessage/createUserMessage（复刻 @deepseek-ai/dsh-llm lib/types/message.js），pluginMessage 改用 createUserMessage 自动 mint UUID id —— 修 user/message 事件缺 data.message.id 导致 dsh-session assertMessageEventShape 拒载、整会话损坏（mem_dsh_20260816_plugin_user_message_missing_id）。配套探针 test/probe-plugin-id.js 15 项 + probe-dev-installed-consistency.mjs 双端 SHA256 一致性 + scripts/check-sync.mjs 发布前同步检查钩子（prepublishOnly）。R-01 双验收 A=PASS/B=PASS（高置信度）

## 10b. 安装探针实战结论（2026-08-16，真实踩坑记录）

探针方式：临时独立 profile + `dsh plugin add file:` + `dsh --profile X "task"` headless + 审计日志（logDir/experience-flywheel.log 的 INJECT 行）作确定性证据。

1. **pre-step 注入契约 = `messages`，不是 `additionalContexts`**（合成谬误 C 类真坑）：
   - `tools/post-execute`：downstream 消费 `additionalContexts`（工具结果路径）
   - `agent/pre-step`：waterfall fallback 是 `{kind:"enter", messages:[...]}`，注入 = append 到 `decision.messages`
   - 用错 = 审计日志有 INJECT、模型却看不到注入
2. **cordis DI**：服务访问 `ctx.commands` 必须先 `export const inject = ["commands"]`，否则 `cannot get property "commands" without inject`
3. **pnpm `file:` 装的是拷贝不是链接**：改源码后必须 remove + add 重装，否则跑旧码（"Already up to date" 不会重拷）
4. **harness 需要 node ≥22.22**（`node:zlib` zstd API），系统 22.14 不行 → 用启动器的 `.workbuddy\binaries\node\versions\22.22.2\node.exe`
5. **headless 无 slash 命令解析器**（命令是 Web GUI 层特性）；命令注册本身不报错即可
6. **npmmirror 镜像缺包**（`dsh-code-runtime-worker` 404，旧版 headless 依赖未发布改名包）→ `--registry=https://registry.npmjs.org` + 钉版本 `@deepseek-ai/dsh-headless@0.1.0-rc.6`

### 双验收阶段发现（2026-08-16，§11 D2/D4 类）
7. **verify-claims 零声明假绿**：`-Claims ";;;"`（有效声明数 0）原实现返回 exit 0 "0 项全部验证通过"——假 PASS。已修：声明数 0 → **exit 2**（无内容可校核即参数错误），防 D2/D4 假绿。回归探针仍 9/9 PASS。

### 双验收第 2 轮（2026-08-16）——双 PASS 达成，附 2 条后续优化（F1/F2 已修，F3 dogfood 追加）
第 1 轮红队 FAIL 的 C1/C2/C3/D1/D4 + C4 全部修复并复验通过（行号证据见 acceptance/verdict-B.md）。红队第 2 轮另提 2 条**架构层优化建议**：
- **F1 搜索子串噪声**：~~MarkdownStore.search 用 `includes` 子串匹配，bigram 只缓解了查询端；文档端子串命中仍有噪声（"经验"命中"经验库/经验主义"）~~ → **已修（v0.1.0+）**：**词边界加权打分**（零依赖，接口不变）——查询 token 在文档中按边界判定 strong/weak：CJK bigram 看前后是否 CJK 字符、ASCII 词看词字符边界；独立出现（两侧都是边界）计 strong=1.0，仅嵌入出现（如"经验"嵌在"经验库"里）计 weak=0.3。score=(strong+0.3×weakOnly)/tokenCount，**recall 保持**（弱命中仍入结果）但噪声文档排序降权。实现见 lib/store.js `tokenHits` + `search`；回归探针 §3f 单测 8 项（tokenize 契约/独立词排第一/噪声降权/recall 保持/ASCII 词边界）两遍一致。
- **F2 claims 累积不清**：~~claimsByAgent 只增不清，长会话验证集合无限增长、重复校验历史文件~~ → **已修（v0.1.0+）**：抽 `lib/claims.js` 纯函数治理（探针可单测）——verify PASS 后移除已验证路径；上限 `maxClaimsPerAgent`（默认 50，最旧先淘汰）；TTL `claimsTtlMs`（默认 24h，过期清理）。实现见 lib/claims.js + lib/index.js post-execute；回归探针 §3d 单测 4 项（上限/TTL/PASS移除/幂等重加）两遍一致。
- **F3 claimed-paths 假阳性（dogfood 抓的真坑，2026-08-16）**：~~claimedPaths 的 key 白名单含 `target`/`source`，Playwright MCP 的 browser_click 参数 `target=f1e84`（元素 ref）被误收成文件路径 → 自动 verify 假阳性阻塞（`VERIFY_FAIL exit 1: f1e84;f1e107;f1e85`）~~ → **已修**：`extractClaimedPaths` 抽到 lib/claims.js（纯函数可单测）——**工具名白名单**（仅 write/edit/move/copy/save/upload/create/append/rename/touch/unlink/delete 等写盘工具跟踪，MCP 前缀也能命中）+ **模糊 key 形状校验**（`target`/`source` 必须长得像路径：盘符/分隔符/扩展名/相对前缀）。回归探针 §3e 单测 8 项（非写盘工具拒绝/明确 key 收/模糊 key 形状校验/空参拒绝）两遍一致。

## 11. 合成谬误 / 分解谬误自检（交付前强制，老李 2026-08-16 拍板）

**这套东西每块单独测都过，合起来会不会崩？整体设计漂亮，某个零件会不会其实烂？**
这是真实项目里高频的系统性翻车，不能靠"感觉对了"放过。交付前对照下表逐条验。

### 11.1 合成谬误（部分对 ≠ 整体对；单测全绿、组装后崩）
已预判的本项目风险点（每条都要在 probe 里真跑"组装态"，不是单件）：

| # | 风险 | 触发条件 | 自检探针 |
|---|---|---|---|
| C1 | **每轮注入经验 → 上下文膨胀**，长会话越积越大，拖垮模型/成本 | pre-step 每轮都注、不截断历史命中 | 起 50 轮会话，量 turn>N 的 messages 总长度曲线，确认有退场/截断（injectTopK 上限 + 老命中不重复注） |
| C2 | **PowerShell 冷启延迟叠加**：pre-step 每 turn spawn 一次 ov-search(~200ms+) + 工具后 verify 再 spawn → 用户感到明显卡 | 全开 + 慢机 | 同一会话连发 10 轮，p95 延迟；超阈值则改常驻/节流/合并 |
| C3 | **注入经验 vs 活指令冲突**：注入的历史经验说 A、用户这轮明说就要改 A——模型两边收到打架 | 经验库有"对策"被现实改了 | 构造反例：先 remember "用 X"，再让 user 指令"不用 X 了"，看模型是否被注入误导 |
| C4 | **双后端切换态错选**：markdown/OV 各自单测过，但 `backend:auto` 在某中间配置（ENV 半设、URL 空但 peer 非空）选错后端而静默退化 | auto + 部分 ENV | probe 跑全 4 种 (openvikingUrl×openvikingPeer) 组合，断言选路与检索结果 |
| C5 | **噪声淹没信号**：auto-verify 每文件弹一次 + gate 命令留痕 + 飞轮提醒，全开时轨迹太花，真警告被埋 | 三件套同时 enabled | 长会话看轨迹，数"真信号/噪声"比，过差则给开关默认关一部分 |
| C6 | **插件叠层互覆盖**：本插件 experience-flywheel 服务与别人插件同 id? 或 patch 层序在我们之后加的 bundle 改了我们 row | 装 ≥2 个带 pre-step 的插件 | 装 repeat-tool-reminder + 本件，断言两者 pre-step 都跑（非替代） |

### 11.2 分解谬误（整体设计漂亮 ≠ 每个零件对；图漂亮、实现烂）
已预判的本项目风险点：

| # | 风险 | 为什么"整体看不错"会漏掉 | 自检探针 |
|---|---|---|---|
| D1 | **中文关键词抽取是菜的**：DESIGN 流程对，但 pre-step 抽关键词靠朴素空格/停用词，中文没分词器 → search 召回为 0，整套飞轮空转 | 流程图看不出"抽取质量"这一环烂 | 喂真实中文 user 消息，断言抽出的词数≥1 且 search 有命中；否则接 jieba/正则 |
| D2 | **exit-code 契约边界没覆盖**：设计写"exit 1 = 缺"，但空计划文件、非 UTF-8 路径、无读权限各退几码没定 → 实现里抛异常被吞成 exit 1，语义错位 | 契约表整齐，异常路径没列 | probe 喂空文件、不存在路径、无权限文件，断言每种的 exit 与契约一致 |
| D3 | **"软硬"被当"真硬"用**：README 标了软硬，但例子/命令文案仍可能让使用者以为能真阻断交付 → 误信 | 整体语气像很可靠 | 评审：命令回灌文案是否明确说"阻塞指令非 kernel veto"，A/B 验收员各读一遍 |
| D4 | **回读校验假 PASS**：ov-remember 写入后 search 命中才算 OK，但 markdown 后端的"命中"若是子串误报（"mem_a" 命中 "mem_ab"）则假绿 | 契约"命中"定义未严格 | 写 mem_a 后 search mem_a"、确认命中是精确那条 uri，非前缀撞 |

### 11.3 自检规程
- 交付前由验收员 B（红队）**专门**跑 §11 两张表，逐条给 PASS/FAIL + 证据。
- 任一 FAIL：不算"合成/分解 OK"，回工，不靠"大概没问题"放过。
- 自检结论随交付汇报附上（和双验收记录、verify-claims 一并）；无 §11 证据 = 交付不完整。
