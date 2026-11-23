#!/usr/bin/env tsx
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { QueryEngine } from "../core/queryEngine.js";
import { query } from "../core/agenticLoop.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import { appendRuntimeContext, isRuntimeContextMessage, type RuntimeEnvironmentContext } from "../context/runtimeContext.js";
import { getProjectMemoryDir } from "../context/memory/memdir.js";
import { prepareRequest } from "../services/api/providers/providerStream.js";
import { resetSettingsCache } from "../config/sources.js";
import { initSessionStorage, appendTranscriptEntry, restoreSession } from "../session/storage.js";
import { isInternalMessage } from "../ui/components/ConversationView.js";
import { loginForTest } from "./helpers/accountFixture.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-prompt-cache-"));
const cwd = path.join(root, "project");
const previousHome = process.env.CCAGENT_HOME;
const previousCwd = process.cwd();
const originalFetch = globalThis.fetch;
const execFileAsync = promisify(execFile);
const account = await loginForTest(path.join(root, "home"));
const settingsPath = path.join(account.home, "settings.json");
const settings = {
  language: "zh-CN",
  models: { fixture: { protocol: "openai-chat", model: "cache-fixture", baseURL: "https://cache.test/v1", contextWindow: 65536 } },
};

try {
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  await fs.writeFile(path.join(cwd, "tracked.txt"), "initial\n");
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["add", "tracked.txt"], { cwd });
  await execFileAsync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Initial"], { cwd });
  process.chdir(cwd);
  resetSettingsCache();

  const env: RuntimeEnvironmentContext = { cwd, toolTempRoot: "/tmp/cache-fixture", date: "2026-10-17", timeZone: "Asia/Shanghai", os: "fixture", gitBranch: "main", gitStatus: "clean", gitRecentCommit: "abc Initial" };
  const changedEnv = { ...env, date: "2026-10-18", gitStatus: " M tracked.txt" };
  const system = (context: RuntimeEnvironmentContext) => buildSystemPrompt({ cwd, environmentContext: context, runtimeStateInMessages: true }).then(renderSystemPrompt);
  assert.equal(await system(env), await system(changedEnv), "date/Git changes cannot rewrite the system prefix");
  const standalone = renderSystemPrompt(await buildSystemPrompt({ cwd, environmentContext: changedEnv }));
  assert.ok(standalone.includes("2026-10-18") && standalone.includes(" M tracked.txt"), "standalone prompt dumps retain current workspace state");

  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools: unknown }> = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).startsWith(account.origin + "/")) return originalFetch(url, init);
    requests.push(JSON.parse(String(init?.body)));
    return new Response([
      `data: ${JSON.stringify({ id: "fixture", choices: [{ delta: { content: "正常" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 5 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const engine = new QueryEngine({ model: "fixture", toolContext: { cwd }, permissionMode: "default", permissionSettings: { mode: "default", allow: [], deny: [] } });
  async function submit(prompt: string): Promise<void> {
    const run = engine.submitMessage(prompt);
    let next = await run.next();
    while (!next.done) {
      if (next.value.type === "error") throw next.value.error;
      next = await run.next();
    }
    assert.equal(next.value.reason, "completed");
  }
  await submit("你好");
  await submit("再回复一次");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages, "the next request preserves the previous input prefix byte-for-byte");
  const snapshots = () => engine.getState().messages.filter(isRuntimeContextMessage);
  assert.equal(snapshots().length, 1, "unchanged state does not add repetitive metadata each turn");
  assert.ok(isInternalMessage(snapshots()[0]!), "workspace metadata stays out of the human transcript");

  await fs.writeFile(path.join(cwd, "tracked.txt"), "changed\n");
  await submit("检查变更");
  assert.equal(requests[2]!.messages[0]!.content, requests[0]!.messages[0]!.content);
  assert.deepEqual(requests[2]!.messages.slice(0, requests[1]!.messages.length), requests[1]!.messages, "fresh Git state is appended without rewriting any earlier input");
  assert.equal(snapshots().length, 2);
  assert.ok(String(snapshots()[1]!.content).includes("M tracked.txt"), "fresh Git state still reaches the model");

  const restored = [...engine.getState().messages];
  assert.equal(appendRuntimeContext(restored, { ...env, gitBranch: "other" }).length, restored.length + 1);
  assert.equal(appendRuntimeContext([], env).length, 1, "clear/compaction reintroduces a missing snapshot");
  const newDay = appendRuntimeContext(appendRuntimeContext([], env), changedEnv);
  assert.ok(String(newDay[newDay.length - 1]!.content).includes("2026-10-18"));

  await fs.writeFile(settingsPath, JSON.stringify({ ...settings, language: "en" }));
  resetSettingsCache();
  await submit("Use English");
  assert.ok(requests[3]!.messages[0]!.content.includes("Respond to the user in en,"), "real language changes are not hidden behind a stale prompt cache");
  const memoryDir = await getProjectMemoryDir(cwd);
  await fs.writeFile(path.join(memoryDir, "MEMORY.md"), "# Updated memory\nFresh memory fixture.\n");
  await submit("Check memory");
  assert.ok(requests[4]!.messages[0]!.content.includes("Fresh memory fixture."), "real memory updates remain visible");

  const profile = { id: "fixture", protocol: "openai-chat" as const, model: "fixture" };
  const toolA = { name: "Zebra", description: "z", input_schema: { type: "object", properties: { z: { type: "string", enum: ["z", "a"] }, a: { type: "number" } }, required: ["z", "a"] } } as Anthropic.Tool;
  const toolB = { name: "Alpha", description: "a", input_schema: { type: "object", properties: {} } } as Anthropic.Tool;
  const reorderedA = { input_schema: { required: ["z", "a"], properties: { a: { type: "number" }, z: { enum: ["z", "a"], type: "string" } }, type: "object" }, description: "z", name: "Zebra" } as Anthropic.Tool;
  const params = { model: "fixture", messages: [{ role: "user" as const, content: "hello" }] };
  const before = JSON.stringify([toolA, toolB]);
  assert.equal(JSON.stringify(prepareRequest(profile, { ...params, tools: [toolA, toolB] }).body), JSON.stringify(prepareRequest(profile, { ...params, tools: [toolB, reorderedA] }).body), "MCP order and equivalent schema object-key order cannot change the wire request");
  assert.equal(JSON.stringify([toolA, toolB]), before, "canonicalization cannot mutate shared schemas or enum/required arrays");

  const callsBeforeCompaction = requests.length;
  const oversizedHistory = Array.from({ length: 31 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `${index}:` + "x".repeat(2000),
  }));
  const compacted = query({ messages: oversizedHistory, model: "fixture", contextWindow: 20_000, runtimeContext: changedEnv, toolContext: { cwd }, maxTurns: 2 });
  let result = await compacted.next();
  while (!result.done) result = await compacted.next();
  assert.equal(result.value.reason, "completed");
  assert.equal(requests.length, callsBeforeCompaction + 2);
  assert.ok(requests[requests.length - 1]!.messages.some((message) => message.content.startsWith("[runtime-context]\n") && message.content.includes("2026-10-18")), "in-loop compaction cannot lose the latest workspace state");

  await initSessionStorage({ sessionId: "fixture", cwd, startedAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", model: "fixture" });
  for (const message of [appendRuntimeContext([], env)[0]!, { role: "user" as const, content: "真实问题" }]) {
    await appendTranscriptEntry(cwd, "fixture", { type: "message", timestamp: "2026-10-17T00:00:00Z", role: "user", message });
  }
  assert.equal((await restoreSession(cwd, "fixture")).summary.firstPrompt, "真实问题", "resume labels use the human prompt rather than metadata");
  console.log("Prompt cache regression checks passed: stable input prefixes, fresh workspace/settings/memory, deterministic tool schemas, and transcript labels.");
} finally {
  globalThis.fetch = originalFetch;
  process.chdir(previousCwd);
  await account.close();
  if (previousHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = previousHome;
  resetSettingsCache();
  await fs.rm(root, { recursive: true, force: true });
}
