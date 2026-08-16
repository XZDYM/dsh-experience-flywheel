// check-sync.mjs — fail if local branch is ahead of or behind origin (pre-publish guard)
// Usage: node scripts/check-sync.mjs  (exit 0 = synced, 1 = not synced)
// Guards against publishing a version whose commits are not yet pushed to origin
// (see mem_dsh_20260816_plugin_push_lag_trap: "ahead N" silently means GitHub is stale).
// Implementation reads .git refs directly (no subprocess spawn — works in sandboxes
// where spawning cmd.exe/git.exe is blocked).
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gitDir = join(root, ".git");

function readRef(path) {
  try {
    const content = readFileSync(path, "utf8").trim();
    if (content.startsWith("ref: ")) {
      return readRef(join(gitDir, content.slice(5).trim()));
    }
    return content;
  } catch {
    return null;
  }
}

// find remote-tracking refs dir (e.g. .git/refs/remotes/origin/master or packed-refs)
function findRemoteHead(branch) {
  const candidates = [
    join(gitDir, "refs", "remotes", "origin", branch),
    join(gitDir, "refs", "remotes", "origin", "HEAD"), // symref, unlikely to be plain
  ];
  for (const c of candidates) {
    const v = readRef(c);
    if (v && !v.startsWith("ref:")) return v;
  }
  // packed-refs fallback
  const packed = join(gitDir, "packed-refs");
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      const m = line.match(/^([0-9a-f]{40}) refs\/remotes\/origin\/(.+)$/);
      if (m && m[2] === branch) return m[1];
    }
  }
  return null;
}

function currentBranch() {
  const head = readRef(join(gitDir, "HEAD")) ?? "";
  if (head.startsWith("refs/heads/")) return head.slice("refs/heads/".length);
  return "master"; // detached fallback
}

const branch = currentBranch();
const local = readRef(join(gitDir, "refs", "heads", branch));
const remote = findRemoteHead(branch);

if (!local) {
  console.error(`SYNC FAIL: no local ref for branch "${branch}"`);
  process.exit(1);
}
if (!remote) {
  console.error(`SYNC FAIL: no remote-tracking ref for origin/${branch} (run "git fetch" first)`);
  process.exit(1);
}

if (local !== remote) {
  console.error(`SYNC FAIL: local ${branch}=${local.slice(0, 8)} != origin/${branch}=${remote.slice(0, 8)}`);
  console.error("  -> run: git fetch && git status --branch, then git push origin " + branch);
  process.exit(1);
}

console.log(`SYNC OK: ${branch} == origin/${branch} (${local.slice(0, 8)})`);
process.exit(0);
