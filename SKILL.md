---
name: experience-flywheel
description: >-
  Cross-session experience flywheel + dual-acceptance gate protocol (universal,
  de-personalized). Auto-query past lessons before each step, auto-verify claimed
  writes, wrap exit-1 gate scripts (plan-gate / close-gate / verify-claims) as
  slash commands. Triggered automatically by the dsh-experience-flywheel service;
  also a readable explanation of the protocol for humans.
---

# Experience Flywheel · 经验飞轮（通用版）

The agent's weights are frozen and each session starts blank — yesterday's pitfalls
are gone. This protocol turns "learn from experience" from "hope the model remembers"
into **server-side automation** that runs whether or not the model chooses to.

## The flywheel, four steps (every problem / task / pitfall)
1. **Before acting on a new problem / step** — query the experience store first.
   The `agent/pre-step` middleware does this **automatically** and injects hits as
   context. (`/flywheel-search <keywords>` is the manual form.)
2. **If hits found** — follow them; don't reinvent. If reality differs, update the
   same memory on the spot (`/flywheel-remember`), don't wait for task end.
3. **If no hits** — proceed normally, but before closing the task, sediment at least
   one new lesson (`/flywheel-remember`). Closing a task without the store being
   more accurate than before = the wheel didn't turn.
4. **Back to 1** — the next problem carries the updated store.

## Sediment template
`【pitfall】observed / 【root cause】one line / 【fix】actionable / 【key path】location / 【date】`
(update in place on the same memory when things change; don't fork).

## Dual-acceptance gate (for any subagent-orchestrated task)
Two independent verifiers, neither knowing the other's verdict:
- **A (reference)** — checks the deliverable against requirements/evidence/reproducibility.
- **B (red team)** — independently re-runs probes, hunts hallucination / missing evidence.
- Gate: both PASS → deliverable; any FAIL → rework; 3 non-convergent rounds → escalate to human.
- `plan-gate.ps1` blocks start until 2 independent verifiers are declared; `close-gate.ps1`
  blocks close until dual-verifier + flywheel + final-check traces all exist.
- **Soft-hard**: the gate's exit 1 injects a hard blocking instruction + trajectory marker;
  a kernel-level "exit 1 prevents delivery" veto is out of scope for rc.6 (see DESIGN §8).

## Final落盘 check
Every claimed write must be re-verified (Test-Path / read-back / grep hit). "I wrote it"
without reproducible evidence = hallucination, rework. `verify-claims.ps1` automates this.
