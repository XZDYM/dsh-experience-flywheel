#!/usr/bin/env node
/**
 * dsh-experience-flywheel — cli.mjs
 * Thin CLI over store.js so the gate scripts share ONE search/remember
 * implementation (no PS/JS logic drift).
 *
 *   node cli.mjs search "query" [--store ./store] [--top 3] [--url http://...] [--peer dsh]
 *   node cli.mjs remember <type> <name> <content...> [--store ./store] [--url http://...] [--peer dsh]
 *
 * Exit codes: search 0=ok(可能 0 命中,打 stdout) 2=失败; remember 0=写入并回读验证 3=回读未命中 2=失败
 */

import { makeStore, MarkdownStore, OpenVikingStore, tokenize } from "./store.js";

function parseArgs(argv) {
  const opts = { positional: [], store: "./store", top: 3, url: "", peer: "dsh" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--store") { opts.store = argv[++i]; }
    else if (a === "--top") { opts.top = Number(argv[++i]) || 3; }
    else if (a === "--url") { opts.url = argv[++i] ?? ""; }
    else if (a === "--peer") { opts.peer = argv[++i] ?? "dsh"; }
    else opts.positional.push(a);
  }
  return opts;
}

function pickStore(opts) {
  const url = (opts.url || process.env.OPENVIKING_URL || "").trim();
  if (url) return new OpenVikingStore({ url, peer: opts.peer || "dsh" });
  return new MarkdownStore(opts.store);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (cmd === "search") {
    const query = opts.positional.join(" ");
    if (!query) { process.stderr.write("usage: cli search <query> [--top N]\n"); process.exit(2); }
    const store = pickStore(opts);
    const hits = await store.search(query, opts.top);
    process.stdout.write(JSON.stringify({ hits: hits.map((h) => ({ ...h })) }) + "\n");
    process.exit(0);
  }

  if (cmd === "remember") {
    const [type, name, ...contentParts] = opts.positional;
    if (!type || !name || contentParts.length === 0) {
      process.stderr.write("usage: cli remember <type> <name> <content...>\n");
      process.exit(2);
    }
    const content = contentParts.join(" ");
    const store = pickStore(opts);
    const result = await store.remember(type, name, content);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.verified ? 0 : 3);
  }

  if (cmd === "tokenize") {
    process.stdout.write(JSON.stringify(tokenize(opts.positional.join(" ") || "")) + "\n");
    process.exit(0);
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(2);
});
