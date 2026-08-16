/**
 * dsh-experience-flywheel — claims.js
 * Per-agent claimed-write tracking with bounded growth (F2 fix).
 *
 * Problem (DESIGN §10b F2): the old claimsByAgent Set only grew — a long session
 * re-verified every historical file forever. Fix:
 *   - verify PASS removes the verified paths (no re-check of history files)
 *   - hard cap on tracked paths (oldest by insertion order evicted first)
 *   - TTL expiry (paths not re-claimed within ttlMs are pruned)
 *
 * Pure functions over an insertion-ordered Map<path, lastClaimedAtMs>, with no
 * imports, so the idempotent probe can unit-test them with plain `node`
 * (test/probe.ps1 section 5) — no harness needed.
 */

export const DEFAULT_MAX_CLAIMS = 50;
export const DEFAULT_CLAIMS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Create a fresh claims tracker. */
export function createClaims({ max = DEFAULT_MAX_CLAIMS, ttlMs = DEFAULT_CLAIMS_TTL_MS } = {}) {
  return { max, ttlMs, map: new Map() };
}

/**
 * Record / refresh a claimed path. Re-claiming an existing path refreshes its
 * timestamp and moves it to the newest insertion position. Enforces the cap by
 * evicting the oldest (first-inserted) entries.
 */
export function addClaim(claims, path, now = Date.now()) {
  if (typeof path !== "string" || path.length === 0) return;
  claims.map.delete(path); // refresh → newest position
  claims.map.set(path, now);
  while (claims.map.size > claims.max) {
    const oldest = claims.map.keys().next().value;
    claims.map.delete(oldest);
  }
}

/** Prune paths whose last claim is older than ttlMs. Returns count removed. */
export function pruneClaims(claims, now = Date.now()) {
  let removed = 0;
  for (const [path, ts] of claims.map) {
    if (now - ts > claims.ttlMs) {
      claims.map.delete(path);
      removed++;
    }
  }
  return removed;
}

/** All currently tracked paths, in insertion order. */
export function listClaims(claims) {
  return [...claims.map.keys()];
}

/** Remove verified paths after a PASS verdict (or any explicit removal). */
export function removeClaims(claims, paths) {
  for (const p of paths) claims.map.delete(p);
}

/** Number of tracked paths. */
export function claimsSize(claims) {
  return claims.map.size;
}

// ── F3: claimed-path extraction（工具名白名单 + 路径形状校验）─────────────
// dogfood 真坑（2026-08-16）：Playwright MCP 的 browser_click 参数 target=f1e84 被
// 当成文件路径收进 claims → verify 假阳性阻塞（VERIFY_FAIL exit 1: f1e84;f1e107;f1e85）。
// 修复：只有写盘类工具才跟踪；target/source 等模糊 key 必须长得像路径才收。

/** 写盘类工具名（子串/正则匹配，MCP 前缀如 mcp__filesystem__write_file 也能命中）。 */
const WRITE_TOOL_RE = /(write|edit|move|copy|save|upload|create|append|rename|touch|unlink|delete)/i;
/** 明确路径参数：文件工具里这些 key 直接可信。 */
const PATH_KEYS = ["file_path", "path", "filename", "destination", "target", "source"];
/** 模糊 key：必须长得像路径才收（防元素 ref / URL / 任意字符串）。 */
const FUZZY_KEYS = new Set(["target", "source"]);

/** 路径形状启发：绝对路径 / 含分隔符 / 含扩展名 / 相对路径前缀。 */
function looksLikePath(v) {
  if (/^[a-zA-Z]:[\\/]/.test(v)) return true;            // C:\... 或 F:/...
  if (/[\\/]/.test(v)) return true;                       // 含分隔符
  if (/\.[a-zA-Z0-9]{1,5}$/.test(v)) return true;         // 有扩展名
  if (/^(\.\.?[\\/])/.test(v)) return true;               // ./ ../ 开头
  return false;
}

/**
 * Extract claimed write paths from a tool call (deterministic, pure).
 * @param {{name?: string, arguments?: Record<string, unknown>}} exec
 * @returns {string[]}
 */
export function extractClaimedPaths(exec) {
  const name = exec?.name ?? "";
  if (!WRITE_TOOL_RE.test(name)) return [];               // 非写盘工具 → 不收
  const args = exec?.arguments ?? {};
  const paths = [];
  for (const k of PATH_KEYS) {
    const v = args[k];
    if (typeof v !== "string" || v.length === 0) continue;
    if (FUZZY_KEYS.has(k) && !looksLikePath(v)) continue; // target/source 形状校验
    paths.push(v);
  }
  return paths;
}
