// probe-dev-installed-consistency.js — 必跑探针: dev/installed 双 SHA256 必须一致
// 用法: node probe-dev-installed-consistency.js
// 退出码: 0=一致  1=不一致
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const devPath = 'F:/DeepSeekHarness/plugins/dsh-experience-flywheel/lib/index.js';
const insPath = 'C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-experience-flywheel/lib/index.js';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const devSha = sha(devPath);
const insSha = sha(insPath);
const devSize = readFileSync(devPath).length;
const insSize = readFileSync(insPath).length;

const ok = devSha === insSha;
console.log(`dev      size=${devSize} sha256=${devSha.slice(0, 16)}...`);
console.log(`installed size=${insSize} sha256=${insSha.slice(0, 16)}...`);
console.log(ok ? 'CONSISTENT ✓' : 'INCONSISTENT ✗');
process.exit(ok ? 0 : 1);
