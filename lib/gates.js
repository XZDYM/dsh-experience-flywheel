/**
 * dsh-experience-flywheel — gates.js
 * Runs the deterministic gate scripts (scripts/*.ps1) via powershell,
 * returning { ok, exitCode, stdout, stderr }. The scripts are the single
 * source of truth for exit codes (0 = pass, 1 = fail, 2/3 = error variants).
 * Runner is idempotent: it never mutates, only reads script output.
 */

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "..", "scripts");

function scriptPath(name) {
  const p = join(SCRIPTS_DIR, name);
  return existsSync(p) ? p : null;
}

/**
 * Run a gate script.
 * @param {string} name - script file name, e.g. 'plan-gate.ps1'
 * @param {string[]} args - arguments
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<{ok:boolean, exitCode:number, stdout:string, stderr:string, missing:boolean}>}
 */
export function runGate(name, args = [], { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const p = scriptPath(name);
    if (!p) {
      resolve({ ok: false, exitCode: 127, stdout: "", stderr: `script not found: ${name}`, missing: true });
      return;
    }
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p, ...args],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code ?? -1, stdout, stderr, missing: false });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, stdout, stderr: String(err), missing: false });
    });
  });
}

/** Convenience: run each gate and return a compact verdict. */
export async function runGates({ planFile, acceptanceFile, claims, requireClaims } = {}) {
  const results = {};
  if (planFile) {
    results.planGate = await runGate("plan-gate.ps1", [planFile]);
  }
  if (acceptanceFile || claims) {
    const args = [];
    if (acceptanceFile) args.push("-Acceptance", acceptanceFile);
    if (claims) args.push("-Claims", claims);
    if (requireClaims) args.push("-RequireClaims", String(requireClaims));
    results.closeGate = await runGate("close-gate.ps1", args);
  }
  if (claims) {
    const args = ["-Claims", claims];
    if (requireClaims) args.push("-RequireClaims", String(requireClaims));
    results.verifyClaims = await runGate("verify-claims.ps1", args);
  }
  return results;
}
