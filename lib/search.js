/**
 * dsh-experience-flywheel — search.js
 * Orchestration over a Store: query-and-inject text, remember-with-verify.
 * Everything here is backend-agnostic and idempotent.
 */

import { tokenize } from "./store.js";

/** Build the system-note text injected at pre-step. Empty when nothing to say. */
export function buildInjectionText(store, query, hits, { topK = 3 } = {}) {
  const lines = [];
  if (hits.length > 0) {
    lines.push(`[经验飞轮] 过去踩过类似的坑，按经验来（score 最高 ${(hits[0].score * 100).toFixed(0)}%）：`);
    for (const h of hits.slice(0, topK)) {
      lines.push(`- ${h.type}/${h.name}（${h.uri}）：${h.abstract}`);
    }
  } else {
    lines.push(`[经验飞轮] 没检索到相关经验——这是新问题，处理完记得沉淀一条（/flywheel-remember）。`);
  }
  return lines.join("\n");
}

/** Extract a search query from the latest user message. */
export function queryFromUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.source?.kind === "user") {
      const text = Array.isArray(m.content)
        ? m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
        : typeof m.content === "string" ? m.content : "";
      const t = tokenize(text);
      if (t.length > 0) return t.slice(0, 8).join(" ");
    }
  }
  return "";
}

/** remember with the verify step baked in (R-04). */
export async function rememberVerified(store, type, name, content) {
  const result = await store.remember(type, name, content);
  return { ...result, verified: Boolean(result.verified) };
}
