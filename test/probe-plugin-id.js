// probe-plugin-id.js — 验证 dsh-experience-flywheel 插件的 pluginMessage 现在生成带 id 的 message
// 用法: 从 plugin 根目录跑 — node test/probe-plugin-id.js
// 退出码: 0=全部 PASS  1=有 FAIL
// 探针项数: 15 项 (①×9: object/id/role/content/text/source.kind/source.form/source.summary/frozen + ②×1 id 唯一 + ③×1 pre-step path + ④×1 post-exec path + ⑤×1 old-bug repro + ⑥×2 source-grep)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_INDEX = join(__dirname, "..", "lib", "index.js");

// === 复刻 dsh-session assertMessageEventShape (line 1242) — 与 plugin factory 必须同步 ===
function assertMessageEventShape(event, subject) {
  const type = event.type;
  if (type !== "user/message" && type !== "assistant/message" && type !== "tool/result") return;
  const data = event.data;
  const record = (typeof data === "object" && data !== null) ? data : undefined;
  const message = type === "user/message" ? record : record?.message;
  if (typeof message !== "object" || message === null
      || typeof message.id !== "string"
      || message.id === "") {
    throw new Error(`${subject} lacks an identified message`);
  }
  const messageRecord = message;
  const expectedRole = type === "assistant/message" ? "assistant" : "user";
  if (messageRecord.role !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`);
  }
  const source = messageRecord.source;
  if (typeof source !== "object" || source === null
      || typeof source.kind !== "string"
      || source.kind === "") {
    throw new Error(`${subject} message has invalid source`);
  }
  if (!Array.isArray(messageRecord.content)) {
    throw new Error(`${subject} message has invalid content`);
  }
}

// === 提取 pluginMessage 源码 (避免把整个 cordis / ctx 链路跑起来) ===
const src = readFileSync(PLUGIN_INDEX, "utf8");

// 收集依赖
const factorySrc = `
function MessageId(id) { return id; }
function deepFreeze(value) {
  const seen = new WeakSet();
  const pending = [{ kind: "visit", node: value }];
  while (pending.length > 0) {
    const task = pending.pop();
    if (task === undefined) continue;
    if (task.kind === "property") {
      pending.push({ kind: "visit", node: task.source[task.key] });
      continue;
    }
    const node = task.node;
    if (node === null || typeof node !== "object") continue;
    if (node instanceof AbortSignal) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      if (key === undefined) continue;
      pending.push({ kind: "property", source: node, key });
    }
  }
  return value;
}
function freezeMessage(message) { return deepFreeze(structuredClone(message)); }
function createMessage(input) {
  return freezeMessage({ ...input, id: MessageId(crypto.randomUUID()) });
}
function createUserMessage(input) {
  return createMessage({ ...input, role: "user" });
}
`;
// 从 plugin 源码里抽出 pluginMessage 函数定义 + 紧跟的 } 结束
const pluginMessageBodyMatch = src.match(/function pluginMessage\(text, summary\)\s*\{[\s\S]*?\n\}/);
if (!pluginMessageBodyMatch) {
  console.error("FAIL: 找不到 pluginMessage 函数定义");
  process.exit(1);
}
const fnSrc = factorySrc + pluginMessageBodyMatch[0];
const pluginMessage = new Function(`${fnSrc}; return pluginMessage;`)();

let fails = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`OK    ${label}${detail ? " — " + detail : ""}`);
  else { console.error(`FAIL  ${label}${detail ? " — " + detail : ""}`); fails++; }
}

// ① pluginMessage 返回的对象
const msg1 = pluginMessage("测试内容", "test summary");
check("① pluginMessage() returns object", typeof msg1 === "object" && msg1 !== null);
check("① msg.id is non-empty string", typeof msg1.id === "string" && msg1.id.length > 0, `id=${msg1.id?.slice(0, 8)}...`);
check("① msg.role === 'user'", msg1.role === "user");
check("① msg.content is array", Array.isArray(msg1.content));
check("① msg.content[0].type === 'text'", msg1.content[0]?.type === "text");
check("① msg.source.kind === 'plugin'", msg1.source?.kind === "plugin");
check("① msg.source.form === 'notice'", msg1.source?.form === "notice");
check("① msg.source.summary === 'test summary'", msg1.source?.summary === "test summary");
check("① msg is frozen (deepFreeze worked)", Object.isFrozen(msg1) && Object.isFrozen(msg1.content) && Object.isFrozen(msg1.source));

// ② 同函数多次调用产生不同 id
const msg2 = pluginMessage("再来一条", "second");
check("② 不同调用产生不同 id", msg1.id !== msg2.id, `${msg1.id?.slice(0,8)} vs ${msg2.id?.slice(0,8)}`);

// ③ pre-step 路径 (waterfall fallback messages)
const decision1 = { kind: "enter", messages: [] };
const injected1 = { ...decision1, messages: [...decision1.messages, pluginMessage("预步注入", "pre-step notice")] };
const evt1 = { type: "user/message", seq: 999, time: Date.now(), data: injected1.messages[injected1.messages.length - 1] };
let threw1 = null;
try { assertMessageEventShape(evt1, "probe pre-step event"); } catch (e) { threw1 = e.message; }
check("③ pre-step 路径 event 通过 assertMessageEventShape", threw1 === null, threw1 ?? "OK");

// ④ post-execute 路径 (additionalContexts)
const downstream = { kind: "accept", additionalContexts: [] };
const injected2 = { ...downstream, additionalContexts: [...downstream.additionalContexts, pluginMessage("post-exec 注入", "post-exec notice")] };
const evt2 = { type: "user/message", seq: 1000, time: Date.now(), data: injected2.additionalContexts[0] };
let threw2 = null;
try { assertMessageEventShape(evt2, "probe post-execute event"); } catch (e) { threw2 = e.message; }
check("④ post-execute 路径 event 通过 assertMessageEventShape", threw2 === null, threw2 ?? "OK");

// ⑤ 反向证明 — 旧版 (裸 pluginMessage 没 id) 现在会失败 (这是断言性失败,应当报错)
const oldBuggyMsg = { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "plugin", form: "notice", summary: "old" } };
const evt3 = { type: "user/message", seq: 1001, time: Date.now(), data: oldBuggyMsg };
let threw3 = null;
try { assertMessageEventShape(evt3, "probe old-buggy event"); } catch (e) { threw3 = e.message; }
check("⑤ 旧 bug 复现 (无 id) 仍会触发校验失败", threw3 !== null && threw3.includes("lacks an identified message"), threw3 ?? "应抛错但未抛");

// ⑥ 验证 patch 后的源码里 pluginMessage 真的调用 createUserMessage
const pluginMessageMatch = src.match(/function pluginMessage\(text, summary\)\s*\{[\s\S]*?\n\}/);
const pluginMessageSrc = pluginMessageMatch ? pluginMessageMatch[0] : "";
check("⑥ 补丁后的 pluginMessage 源码含 createUserMessage 调用", pluginMessageSrc.includes("createUserMessage"), pluginMessageSrc.replace(/\s+/g, " ").slice(0, 200));
check("⑥ 补丁后的 pluginMessage 源码不含裸 role 字段直接返回", !pluginMessageSrc.includes('role: "user"'), "应通过 createUserMessage 设 role");

console.log("---");
if (fails > 0) {
  console.error(`PROBE FAIL: ${fails} 项未通过`);
  process.exit(1);
} else {
  console.log("PROBE ALL PASS");
  process.exit(0);
}