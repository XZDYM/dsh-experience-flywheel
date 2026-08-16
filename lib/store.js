/**
 * dsh-experience-flywheel — store.js
 * Backend abstraction over experience storage:
 *   - MarkdownStore (default, zero deps): <storePath>/<type>/<name>.md
 *   - OpenVikingStore (optional): vector retrieval via OPENVIKING_URL
 * Selection: config.backend === 'openviking' → OpenViking;
 *            'auto' → OpenViking if url configured, else Markdown.
 * All methods are idempotent-safe: repeat calls don't corrupt state.
 *
 * F1 (search denoise, 2026-08-16): MarkdownStore.search now scores hits by
 * word-boundary awareness instead of raw substring matching — a query token
 * counts as a *strong* hit when it appears as a standalone word (CJK bigram
 * bounded by non-CJK on both sides; ASCII word bounded by non-word chars),
 * and as a *weak* hit when it only appears embedded inside a longer token
 * (e.g. query 经验 matching 经验库/经验主义). Weak hits keep recall but get
 * demoted (score weight 0.3), so noisy documents rank below precise ones.
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";

/** A single experience hit. */
export class Hit {
  constructor({ uri, type, name, score, abstract }) {
    this.uri = uri;       // e.g. store://patterns/mem_x.md or viking://...
    this.type = type;     // patterns | entities | preferences | experiences
    this.name = name;     // file basename without .md
    this.score = score;   // 0..1, 1 = exact
    this.abstract = abstract; // first meaningful line
  }
}

/** Extract the first non-empty line of a markdown body as the abstract. */
function abstractOf(body, maxLen = 160) {
  const first = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("---"));
  return first ? first.slice(0, maxLen) : "";
}

/** Normalize a query into tokens: ascii words + CJK bigrams (with single-char fallback).
 *  Bigrams make Chinese phrases like "经验" survive as one unit (D1 fix: single chars
 *  alone cause noise / near-zero recall on Chinese). */
export function tokenize(query) {
  if (!query) return [];
  const ascii = (query.match(/[a-zA-Z0-9_-]{2,}/g) ?? []);
  const cjkChars = (query.match(/[\u4e00-\u9fff]/g) ?? []);
  if (cjkChars.length === 0) return ascii;
  const bigrams = [];
  for (let i = 0; i < cjkChars.length - 1; i++) bigrams.push(cjkChars[i] + cjkChars[i + 1]);
  // Bigrams first; single chars only when no bigrams exist (avoid noise).
  return [...bigrams, ...(bigrams.length === 0 ? cjkChars : []), ...ascii];
}

function memoryFileName(type, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_").slice(0, 120);
  return `mem_${safe}.md`;
}

// ── F1: word-boundary helpers ───────────────────────────────────────────────
const CJK_RE = /[\u4e00-\u9fff]/;
const WORD_RE = /[a-zA-Z0-9_-]/;

/** Is `ch` a CJK char (undefined = string edge, treated as boundary)? */
function isCjk(ch) {
  return ch !== undefined && CJK_RE.test(ch);
}

/** Is `ch` an ascii word char (undefined = string edge, treated as boundary)? */
function isWordChar(ch) {
  return ch !== undefined && WORD_RE.test(ch);
}

/**
 * How a token occurs in `lowerBody`:
 *  - strong: at least one occurrence bounded by non-word chars on BOTH sides
 *    (CJK bigrams use CJK boundaries; ascii words use word-char boundaries).
 *  - weak: only occurrences embedded inside a longer token.
 * @returns {{strong: boolean, weak: boolean}}
 */
function tokenHits(lowerBody, token) {
  const boundary = isCjk(token[0]) ? isCjk : isWordChar;
  const tokenLower = token.toLowerCase();
  let strong = false;
  let weak = false;
  let idx = lowerBody.indexOf(tokenLower);
  while (idx !== -1) {
    const before = idx > 0 ? lowerBody[idx - 1] : undefined;
    const after = idx + tokenLower.length < lowerBody.length ? lowerBody[idx + tokenLower.length] : undefined;
    if (!boundary(before) && !boundary(after)) strong = true;
    else weak = true;
    idx = lowerBody.indexOf(tokenLower, idx + tokenLower.length);
  }
  return { strong, weak };
}

/** Default local markdown backend — zero dependencies. */
export class MarkdownStore {
  constructor(root) {
    this.root = root;
  }

  _file(type, name) {
    return join(this.root, type, memoryFileName(type, name));
  }

  async _ensureDir(type) {
    await mkdir(join(this.root, type), { recursive: true });
  }

  /** remember(type, name, content) → { uri, verified } — writes then re-reads. */
  async remember(type, name, content) {
    const file = this._file(type, name);
    await this._ensureDir(type);
    await writeFile(file, content, "utf8");
    const reread = await readFile(file, "utf8");
    const verified = reread === content;
    return { uri: `store://${type}/${basename(file)}`, verified };
  }

  /** search(query, topK) → Hit[] — word-boundary aware scoring (F1).
   *  Score: (strongCount + 0.3 * weakOnlyCount) / tokenCount. Keeps recall
   *  (weak hits still match) but demotes embedded-only noise below standalone
   *  matches, so "经验" ranks a doc that says 经验 above one that only
   *  contains 经验库. Deterministic and idempotent (read-only). */
  async search(query, topK = 3) {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const hits = [];
    for (const type of ["patterns", "entities", "preferences", "experiences"]) {
      const dir = join(this.root, type);
      if (!existsSync(dir)) continue;
      for (const entry of await readdir(dir)) {
        if (!entry.endsWith(".md")) continue;
        const file = join(dir, entry);
        let body = "";
        try { body = await readFile(file, "utf8"); } catch { continue; }
        const name = basename(entry, ".md").replace(/^mem_/, "");
        const lower = body.toLowerCase();
        let strong = 0, weakOnly = 0;
        for (const t of tokens) {
          const { strong: s, weak: w } = tokenHits(lower, t);
          if (s) strong++;
          else if (w) weakOnly++;
        }
        if (strong + weakOnly === 0) continue;
        const score = (strong + 0.3 * weakOnly) / tokens.length;
        hits.push(new Hit({
          uri: `store://${type}/${entry}`,
          type, name,
          score,
          abstract: abstractOf(body),
        }));
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  /** list() → names per type (used by verify probes). */
  async list(type) {
    const dir = join(this.root, type);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const entry of await readdir(dir)) if (entry.endsWith(".md")) out.push(basename(entry, ".md"));
    return out;
  }
}

/** OpenViking backend — vector retrieval; used when OPENVIKING_URL is set. */
export class OpenVikingStore {
  constructor({ url, peer = "dsh" }) {
    this.url = url.replace(/\/+$/, "");
    this.peer = peer;
  }

  async _post(path, body) {
    const resp = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openviking-actor-peer": this.peer },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`openviking ${path} → HTTP ${resp.status}`);
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { status: "ok", result: text }; }
  }

  async remember(type, name, content) {
    const uri = `viking://user/default/peers/${this.peer}/memories/${type}/mem_${name}.md`;
    const resp = await this._post("/api/v1/content/write", {
      uri, content, mode: "create", wait: true,
    });
    // Verify by exact URI match (D4 fix: search() strips the mem_ prefix, so compare
    // against the stripped name, and match exact name — never substring).
    const hits = await this.search(name, 5);
    const verified = hits.some((h) => h.name === name && h.uri === uri);
    return { uri, verified };
  }

  async search(query, topK = 3) {
    const resp = await this._post("/api/v1/search/search", {
      query, limit: topK, score_threshold: 0.3,
    });
    const memories = resp?.result?.memories ?? resp?.result?.results ?? [];
    return memories.map((m) => new Hit({
      uri: m.uri ?? "",
      type: (m.uri ?? "").match(/\/memories\/(\w+)\//)?.[1] ?? "?",
      name: basename(m.uri ?? "").replace(/^mem_/, "").replace(/\.md$/, ""),
      score: m.score ?? 0,
      abstract: (m.abstract ?? "").split("\n")[0] ?? "",
    })).slice(0, topK);
  }
}

/** Store factory honoring config + env. Fail-fast when backend=openviking but URL empty (C4 fix). */
export function makeStore(config) {
  const ovUrl = (config.openvikingUrl || process.env.OPENVIKING_URL || "").trim();
  const mode = config.backend || "auto";
  if (mode === "openviking") {
    if (!ovUrl) throw new Error("experience-flywheel: backend=openviking 但 OPENVIKING_URL 为空（fail-fast，拒绝静默失效）");
    return new OpenVikingStore({ url: ovUrl, peer: config.openvikingPeer || "dsh" });
  }
  if (mode === "auto" && ovUrl) {
    return new OpenVikingStore({ url: ovUrl, peer: config.openvikingPeer || "dsh" });
  }
  return new MarkdownStore(config.storePath || "./store");
}
