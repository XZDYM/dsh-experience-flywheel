# dsh-experience-flywheel · DSH 经验飞轮插件

> Give your DeepSeek Harness agent a cross-session "muscle memory":
> it **automatically** queries past lessons before each step and injects hits,
> **automatically** verifies claimed file writes, and wraps deterministic
> exit-1 gate scripts (plan-gate / close-gate / verify-claims) as slash commands.
>
> 给 DeepSeek Harness agent 装上跨会话"经验肌肉记忆":每轮动手前**自动**查经验并注入命中，
> 写完文件**自动**校核"声称写了"是否真写了,并把确定性的 exit-1 闸门脚本
> (plan-gate / close-gate / verify-claims)包成 slash 命令。
>
> Status: **v0.1.0 released** — see [DESIGN.md](./DESIGN.md).

## Why / 为什么造它
Pure-text LLM agents wake up fresh every session: yesterday's pitfalls, preferences,
decisions are gone. This plugin turns "learn from experience" from "hope the model
remembers" into **server-side automation**: the `agent/pre-step` middleware runs the
experience query every turn **without the model choosing to**, the same seam
`dsh-repeat-tool-reminder` already uses.

## How / 怎么工作
- `ctx.on("agent/pre-step")` → auto query store, inject top-K hits as a system message.
- `ctx.on("tools/post-execute")` → after file-write tools, auto-run `verify-claims`.
- **Claims hygiene (F2)**: per-agent claimed-write set is bounded — verified paths are
  removed after a PASS, capped at `maxClaimsPerAgent` (default 50), and pruned by
  `claimsTtlMs` (default 24h), so long sessions never re-verify history forever.
- slash commands `/flywheel-search` `/flywheel-remember` `/plan-gate` `/close-gate` `/verify` wrap exit-1 scripts.
- **Backend**: local markdown folder by default (zero deps); set `OPENVIKING_URL` to upgrade to vector retrieval.
- **Honest limit (软硬)**: rc.6 event listeners that throw are warned, not fatal — a true
  kernel-level "exit 1 prevents delivery" veto is **not** supported; the gate's exit 1 is
  injected as a hard blocking instruction + visible trajectory marker instead. See DESIGN §8.

## Install / 安装
```
dsh plugin --profile web add github:<owner>/dsh-experience-flywheel
```
Then restart DSH web. GitHub topic: `dsh-plugin`.

## Decoupled / 去私货
No OpenViking hard-binding, no hardcoded paths, no personal rules. The kernel is the
**flywheel protocol + gate contracts**; your private AGENTS.md stays yours. An optional
`examples/agents.md.fragment` is provided for users who want to wire the protocol into their own instructions.

## License
MIT.
