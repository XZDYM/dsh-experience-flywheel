/**
 * dsh-experience-flywheel — index.js (plugin entry)
 *
 * Exports { name, Config, apply } per the dsh service registration API
 * (mirrors @deepseek-ai/dsh-repeat-tool-reminder).
 *
 * Seams used (verified against rc.6):
 *  - ctx.on("agent/pre-step",   ({agent,messages}, next)) → inject experience hits
 *  - ctx.on("tools/post-execute",(exec,_result,next))     → track claimed writes; auto-verify at delivery keywords
 *  - ctx.commands.register({name,description,input,handler}) → slash commands
 *
 * Honest boundary (软硬): listeners can inject context (additionalContexts) but
 * cannot hard-veto a turn; gate exit-1 surfaces as a blocking instruction.
 */

import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/cordis";

import { makeStore } from "./store.js";
import { queryFromUserMessage, buildInjectionText, rememberVerified } from "./search.js";
import { runGate } from "./gates.js";
import { createClaims, addClaim, pruneClaims, listClaims, removeClaims, claimsSize } from "./claims.js";

export const name = "experience-flywheel";

/** Services this plugin depends on (cordis DI declaration — required before ctx.<svc> access). */
export const inject = ["commands"];

export const Config = z.object({
  backend: z.string().default("auto"),
  storePath: z.string().default("./store"),
  openvikingUrl: z.string().default(""),
  openvikingPeer: z.string().default("dsh"),
  injectTopK: z.number().default(3),
  registerCommands: z.boolean().default(true),
  autoVerify: z.boolean().default(true),
  verifyKeywords: z.array(z.string()).default(["交付", "验收", "完成", "done", "deliver"]),
  // C3: 用户消息命中这些词 → 本轮抑制注入（活指令优先于历史经验）
  suppressKeywords: z.array(z.string()).default(["不要按经验", "别按经验", "忽略经验", "不用老办法", "别用老办法", "ignore experience", "新方法", "别按老办法", "不听经验"]),
  // C2: verify-claims 每 agent 最小触发间隔（毫秒），防冷启叠加
  verifyCooldownMs: z.number().default(30000),
  // F2: claims 治理 —— 上限 + TTL + PASS 后移除，防长会话无限累积
  maxClaimsPerAgent: z.number().default(50),
  claimsTtlMs: z.number().default(24 * 60 * 60 * 1000),
  logDir: z.string().default(""),
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..");

/** A plugin-stamped user message (source.kind:"plugin" is load-bearing). */
function pluginMessage(text, summary) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", form: "notice", summary },
  };
}

function resolveStorePath(config) {
  const raw = config.storePath || "./store";
  return isAbsolute(raw) ? raw : join(PLUGIN_ROOT, raw);
}

/** Audit log: every injection / gate event lands here (deterministic probe evidence). */
function makeLogger(config) {
  const raw = config.logDir || join(PLUGIN_ROOT, "logs");
  const dir = isAbsolute(raw) ? raw : join(PLUGIN_ROOT, raw);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const file = join(dir, "experience-flywheel.log");
  return (event, detail) => {
    try {
      appendFileSync(file, `${new Date().toISOString()}  ${event}  ${detail}\n`, "utf8");
    } catch {}
  };
}

/** Cheap, deterministic file-path extraction from a tool call's arguments. */
function claimedPaths(exec) {
  const args = exec?.arguments ?? {};
  const paths = [];
  const keys = ["file_path", "path", "filename", "target", "source"];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) paths.push(v);
  }
  return paths;
}

function matchesAny(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/** Latest user-authored text from a pre-step messages array. */
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.source?.kind === "user") {
      if (Array.isArray(m.content)) return m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");
      if (typeof m.content === "string") return m.content;
    }
  }
  return "";
}

export function apply(ctx, config) {
  const store = makeStore({ ...config, storePath: resolveStorePath(config) });
  const log = makeLogger(config);

  // C1: per-agent set of already-injected URIs — old hits never re-injected (dedup/退场).
  const injectedUris = new WeakMap();
  // C2: per-agent last-verify timestamp — throttles powershell spawns.
  const lastVerifyAt = new WeakMap();

  // ── agent/pre-step: auto query experience and inject hits ──────────────
  // Contract (verified in rc.6): pre-step is a waterfall whose fallback result is
  // { kind: "enter", messages: [...] } — injection = append our plugin message to
  // decision.messages. (additionalContexts is the TOOL-result path, NOT pre-step.)
  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter") return decision;
    try {
      const query = queryFromUserMessage(messages);
      if (query) {
        // C3: 活指令优先 — latest user text matches suppress keywords → skip this turn.
        const userText = latestUserText(messages);
        if (matchesAny(userText, config.suppressKeywords)) {
          log("SUPPRESS", query);
          return decision;
        }
        const hits = await store.search(query, config.injectTopK);
        if (hits.length > 0) {
          // C1: filter out already-injected URIs for this agent.
          const seen = injectedUris.get(agent) ?? new Set();
          const fresh = hits.filter((h) => !seen.has(h.uri));
          if (fresh.length === 0) {
            log("NODUP", query);
            return decision;
          }
          for (const h of fresh) seen.add(h.uri);
          injectedUris.set(agent, seen);
          const text = buildInjectionText(store, query, fresh, { topK: fresh.length });
          log("INJECT", `${query} -> ${fresh.length} fresh hits: ${fresh.map((h) => h.uri).join(",")}`);
          return {
            ...decision,
            messages: [...(decision.messages ?? []), pluginMessage(text, `经验飞轮: ${fresh.length} 条命中`)],
          };
        } else {
          log("NOHIT", query);
        }
      }
    } catch (error) {
      ctx.logger?.warn?.("experience-flywheel: pre-step query failed: " + (error?.message ?? error));
    }
    return decision;
  });

  // ── tools/post-execute: track claimed writes; auto-verify on delivery keywords ──
  // F2: claims 集合有界 —— verify PASS 后移除已验证路径；上限 maxClaimsPerAgent；
  //     TTL claimsTtlMs 过期自动清理（claims.js 纯函数，探针可单测）。
  const claimsByAgent = new WeakMap();
  ctx.on("tools/post-execute", async (exec, _result, next) => {
    const downstream = await next();
    if (!downstream) return downstream;
    try {
      const agent = exec?.agent;
      if (agent && config.autoVerify) {
        const tracker = claimsByAgent.get(agent) ?? createClaims({
          max: config.maxClaimsPerAgent,
          ttlMs: config.claimsTtlMs,
        });
        claimsByAgent.set(agent, tracker);
        pruneClaims(tracker); // TTL: 过期声称先出集合
        const paths = claimedPaths(exec);
        for (const p of paths) addClaim(tracker, p);
        // Auto-verify only when the step mentions delivery keywords (cheap; no per-file spawn).
        const stepText = JSON.stringify(exec?.arguments ?? "") + " " + JSON.stringify(_result ?? "");
        if (matchesAny(stepText, config.verifyKeywords)) {
          const list = listClaims(tracker);
          if (list.length > 0) {
            // C2: cooldown — don't spawn powershell more than once per verifyCooldownMs per agent.
            const now = Date.now();
            const last = lastVerifyAt.get(agent) ?? 0;
            if (now - last >= config.verifyCooldownMs) {
              lastVerifyAt.set(agent, now);
              const verdict = await runGate("verify-claims.ps1", ["-Claims", list.join(";")]);
              if (!verdict.ok && !verdict.missing) {
                log("VERIFY_FAIL", `exit ${verdict.exitCode}: ${list.join(";")}`);
                return {
                  ...downstream,
                  additionalContexts: [
                    pluginMessage(
                      `【飞轮闸门】verify-claims 判定失败（exit ${verdict.exitCode}）：以下声称写入未全部验证通过：${list.join("; ")}。修复后再交付。\n${verdict.stdout || verdict.stderr}`,
                      "verify-claims: FAIL"
                    ),
                    ...(downstream.additionalContexts ?? []),
                  ],
                };
              } else if (verdict.ok) {
                // F2: PASS → 已验证路径出集合，不再重复校验历史文件
                removeClaims(tracker, list);
                log("VERIFY_PASS", `exit 0: ${list.join(";")} (${claimsSize(tracker)} 条仍在跟踪)`);
              }
            } else {
              log("VERIFY_THROTTLED", `cooldown ${now - last}ms < ${config.verifyCooldownMs}ms`);
            }
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.("experience-flywheel: post-execute failed: " + (error?.message ?? error));
    }
    return downstream;
  });

  // ── slash commands ─────────────────────────────────────────────────────
  if (config.registerCommands) {
    const commands = ctx.commands;
    if (commands?.register) {
      commands.register({
        name: "flywheel-search",
        description: "查经验库：/flywheel-search <关键词>",
        input: { hint: "经验检索关键词" },
        handler: async ({ rawInput }) => {
          const query = (rawInput ?? "").trim();
          if (!query) return { kind: "error", text: "用法: /flywheel-search <关键词>" };
          const hits = await store.search(query, config.injectTopK);
          if (hits.length === 0) return { kind: "success", text: "无命中。" };
          return {
            kind: "success",
            text: hits.map((h) => `[${(h.score * 100).toFixed(0)}%] ${h.type}/${h.name} — ${h.abstract}`).join("\n"),
          };
        },
      });

      commands.register({
        name: "flywheel-remember",
        description: "沉淀经验：/flywheel-remember <type> <name> <内容>",
        input: { hint: "type name 内容" },
        handler: async ({ rawInput }) => {
          const parts = (rawInput ?? "").trim().split(/\s+/);
          if (parts.length < 3) return { kind: "error", text: "用法: /flywheel-remember <patterns|entities|preferences|experiences> <name> <内容>" };
          const type = parts[0];
          const namePart = parts[1];
          const content = parts.slice(2).join(" ");
          const result = await rememberVerified(store, type, namePart, content);
          if (!result.verified) return { kind: "error", text: `写入后回读校验失败: ${result.uri}` };
          return { kind: "success", text: `已沉淀并回读验证: ${result.uri}` };
        },
      });

      commands.register({
        name: "plan-gate",
        description: "编制闸门：计划文件必须声明双验收员（A 对照 + B 红队）",
        input: { hint: "计划文件路径" },
        handler: async ({ rawInput }) => {
          const file = (rawInput ?? "").trim();
          if (!file) return { kind: "error", text: "用法: /plan-gate <计划文件>" };
          const verdict = await runGate("plan-gate.ps1", [file]);
          if (verdict.ok) return { kind: "success", text: `plan-gate PASS: ${file}` };
          return { kind: "error", text: `plan-gate FAIL (exit ${verdict.exitCode}): ${verdict.stdout || verdict.stderr}` };
        },
      });

      commands.register({
        name: "close-gate",
        description: "收官闸门：双验收留痕 + 飞轮留痕 + 收尾校核",
        input: { hint: "-Acceptance <验收记录> -Claims <声称写入清单>" },
        handler: async ({ rawInput }) => {
          const args = (rawInput ?? "").trim().split(/\s+/);
          const verdict = await runGate("close-gate.ps1", args);
          if (verdict.ok) return { kind: "success", text: `close-gate PASS (exit 0)` };
          return { kind: "error", text: `close-gate FAIL (exit ${verdict.exitCode}): ${verdict.stdout || verdict.stderr}` };
        },
      });

      commands.register({
        name: "verify",
        description: "收尾校核：声称写入的文件必须真实存在",
        input: { hint: "路径1;路径2:contains=关键字;..." },
        handler: async ({ rawInput }) => {
          const claims = (rawInput ?? "").trim();
          if (!claims) return { kind: "error", text: "用法: /verify 路径1;路径2:contains=关键字" };
          const verdict = await runGate("verify-claims.ps1", ["-Claims", claims]);
          if (verdict.ok) return { kind: "success", text: `verify-claims PASS: ${claims}` };
          return { kind: "error", text: `verify-claims FAIL (exit ${verdict.exitCode}): ${verdict.stdout || verdict.stderr}` };
        },
      });
    } else {
      ctx.logger?.warn?.("experience-flywheel: commands service unavailable, slash commands skipped");
    }
  }
}
