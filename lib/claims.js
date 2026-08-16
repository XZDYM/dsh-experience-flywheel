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
