#!/usr/bin/env tsx
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QueryEngine } from "../core/queryEngine.js";
import { query, runTools } from "../core/agenticLoop.js";
import { getToolsApiParams, registerMcpTools, clearMcpTools, findToolByName } from "../tools/index.js";
import { toolToApiParam, type Tool } from "../tools/Tool.js";
import { CORE_TOOL_NAMES, ToolDiscovery } from "../tools/toolDiscovery.js";
import { toolSearchTool } from "../tools/toolSearchTool.js";
import { resetSettingsCache } from "../config/sources.js";
import { loginForTest } from "./helpers/accountFixture.js";
import { initSessionStorage, appendTranscriptEntry } from "../session/storage.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-tool-discovery-"));
const previousHome = process.env.CCAGENT_HOME;
const previousCwd = process.cwd();
const originalFetch = globalThis.fetch;
const account = await loginForTest(path.join(root, "home"));
const cwd = path.join(root, "project");
let mcpEnabled = true;
let searchCalls = 0;
const searchName = "mcp__google-gmail__search_threads";
const tools: Tool[] = [
  { name: searchName, description: "Search Gmail email threads. " + "Long schema documentation. ".repeat(100),
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    isEnabled: () => mcpEnabled, isReadOnly: () => true,
    async call() { searchCalls++; return { content: "fixture-mail-result" }; } },
  ...Array.from({ length: 58 }, (_, index): Tool => ({
    name: `mcp__google-drive__operation_${String(index).padStart(2, "0")}`,
    description: "Drive fixture " + "Deferred schema documentation. ".repeat(100),
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    isEnabled: () => mcpEnabled, isReadOnly: () => true,
    async call() { throw new Error("Unexpected unrelated MCP execution"); },
  })),
];

try {
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(account.home, { recursive: true });
  await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify({
    models: { fixture: { protocol: "openai-chat", model: "discovery-fixture", baseURL: "https://discovery.test/v1", contextWindow: 65536 } },
  }));
  process.chdir(cwd);
  resetSettingsCache();
  registerMcpTools(tools);
  const discovery = new ToolDiscovery(() => getToolsApiParams());
  assert.deepEqual(new Set(discovery.getVisibleTools().map((tool) => tool.name)), CORE_TOOL_NAMES);
  assert.ok(JSON.stringify(discovery.getVisibleTools()).length < JSON.stringify(getToolsApiParams()).length * 0.1, "59 MCP definitions stay off the initial wire request");
  const directory = discovery.discover({});
  assert.ok(directory.groups?.some((group) => group.id === "mcp:google-gmail"));
  assert.equal(JSON.stringify(directory).includes("input_schema"), false);
  assert.equal(discovery.getVisibleTools().length, CORE_TOOL_NAMES.size, "listing metadata cannot load every group");
  const newCapabilities = new ToolDiscovery(() => getToolsApiParams());
  assert.deepEqual(newCapabilities.discover({ group: "images" }).loaded.sort(), ["GenerateImage", "ReadImage"]);
  assert.deepEqual(newCapabilities.discover({ query: "分析本地表格数据", limit: 1 }).loaded, ["AnalyzeData"]);
  assert.deepEqual(newCapabilities.discover({ query: "搜索知识库", limit: 1 }).loaded, ["KnowledgeSearch"]);

  const email = discovery.discover({ query: "搜索最近 Gmail 邮件", limit: 1 });
  assert.deepEqual(email.loaded, [searchName], "Chinese task searches resolve an enabled service/operation");
  assert.equal(searchCalls, 0, "discovery cannot invoke the selected tool");
  const docs = discovery.discover({ group: "documents" });
  assert.equal(docs.loaded.length, 4);
  assert.ok(docs.loaded.every((name) => !name.startsWith("mcp__")));
  assert.equal(discovery.discover({ group: "mcp:google-drive" }).loaded.length, 3, "a large MCP service stays bounded to three tools by default");
  const beforeInvalid = JSON.stringify(discovery.getVisibleTools());
  assert.ok(discovery.discover({ names: ["Write", "not-in-this-scope"] }).error);
  assert.equal(JSON.stringify(discovery.getVisibleTools()), beforeInvalid, "invalid exact-name batches cannot partially load tools");
  assert.ok(discovery.discover({ query: "gmail", limit: 1000 }).error);
  assert.ok(discovery.discover({ query: "gmail", names: [searchName] }).error);
  mcpEnabled = false;
  assert.ok(!discovery.getVisibleTools().some((tool) => tool.name === searchName), "closing an MCP removes even already-loaded definitions");
  assert.ok(discovery.discover({ names: [searchName] }).error);
  mcpEnabled = true;
  const restricted = new ToolDiscovery(() => [toolToApiParam(toolSearchTool), toolToApiParam(findToolByName("Read")!)]);
  assert.ok(restricted.discover({ names: ["Write"] }).error, "a child catalogue cannot expand its declared tool pool");
  const scopedWrite = new ToolDiscovery(() => [toolToApiParam(findToolByName("Write")!)]);
  assert.deepEqual(scopedWrite.getVisibleTools().map((tool) => tool.name), ["Write"], "a scope without ToolSearch retains its explicitly allowed tools");
  const failedHistory = new ToolDiscovery(() => getToolsApiParams());
  failedHistory.restore([
    { role: "assistant", content: [{ type: "tool_use", id: "failed_write", name: "Write", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "failed_write", content: "Not loaded", is_error: true }] },
  ]);
  assert.ok(!failedHistory.getVisibleTools().some((tool) => tool.name === "Write"), "a failed unadvertised call cannot activate a schema just by appearing in history");

  type Reply = { name: string; input: Record<string, unknown> } | { text: string };
  let queue: Reply[] = [];
  const requests: Array<{ tools: Array<{ function: { name: string; parameters: unknown } }>; messages: Array<{ role: string; content: string }> }> = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).startsWith(account.origin + "/")) return originalFetch(url, init);
    requests.push(JSON.parse(String(init?.body)));
    const item = queue.shift();
    assert.ok(item, "no extra model calls are needed");
    const tool = "name" in item;
    const delta = tool ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: item.name, arguments: JSON.stringify(item.input) } }] } : { content: item.text };
    const finish = tool ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: `fixture_${requests.length}`, choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 500, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const engineOptions = { model: "fixture", toolContext: { cwd }, permissionMode: "default" as const, permissionSettings: { mode: "default" as const, allow: [], deny: ["Write"] } };
  const engine = new QueryEngine(engineOptions);
  async function submit(prompt: string, replies: Reply[]): Promise<void> {
    queue = replies;
    const run = engine.submitMessage(prompt);
    let next = await run.next();
    while (!next.done) {
      if (next.value.type === "error") throw next.value.error;
      next = await run.next();
    }
    assert.equal(next.value.reason, "completed");
    assert.equal(queue.length, 0);
  }
  await submit("搜索最近 Gmail 邮件", [
    { name: "ToolSearch", input: { query: "Gmail search threads", limit: 1 } },
    { name: searchName, input: { query: "newer_than:7d" } },
    { text: "Found fixture mail." },
  ]);
  assert.equal(requests[0]!.tools.length, CORE_TOOL_NAMES.size);
  assert.ok(!JSON.stringify(requests[0]!.tools).includes("Long schema documentation"));
  assert.ok(requests[1]!.tools.some((tool) => tool.function.name === searchName), "successful discovery advertises the real schema on the next API iteration");
  assert.ok(!requests[1]!.tools.some((tool) => tool.function.name.startsWith("mcp__google-drive")), "unrelated service schemas are never sent");
  assert.equal(searchCalls, 1, "the loaded MCP still executes through the central tool pipeline");
  assert.ok(requests[2]!.messages.some((message) => message.role === "tool" && message.content.includes("fixture-mail-result")));
  await submit("继续", [{ text: "Continued." }]);
  assert.equal(JSON.stringify(requests[2]!.tools), JSON.stringify(requests[3]!.tools), "loaded definitions remain stable across foreground turns for cache reuse");
  const resumed = new QueryEngine({ ...engineOptions, initialMessages: engine.getState().messages });
  assert.ok(resumed.getModelTools().some((tool) => tool.name === searchName), "saved discovery results rehydrate the resumed tool selection");

  await submit("写入测试", [
    { name: "ToolSearch", input: { names: ["Write"] } },
    { name: "Write", input: { file_path: "must-not-exist.txt", content: "blocked" } },
    { text: "Write was denied." },
  ]);
  assert.ok(requests[6]!.messages.some((message) => message.role === "tool" && message.content.toLowerCase().includes("denied")), "loading Write cannot bypass an explicit deny rule");
  await assert.rejects(fs.access(path.join(cwd, "must-not-exist.txt")));
  await submit("不要转换文件", [
    { name: "WordToPdf", input: { input_path: "missing.docx" } },
    { text: "Load tools first." },
  ]);
  assert.ok(requests[8]!.messages.some((message) => message.role === "tool" && message.content.includes("was not loaded")), "an unadvertised tool cannot execute before discovery");

  const plan = await runTools([{ type: "tool_use", id: "plan_discovery", name: "ToolSearch", input: { group: "planning" } }], { cwd, discoverTools: restricted.discover.bind(restricted) }, { permissionMode: "plan", permissionSettings: { mode: "plan", allow: [], deny: [] } });
  // Restricted has no planning tools, but the error comes from discovery, not plan permissions.
  assert.ok(String(plan.executions[0]!.result.content).includes("No available tools in group"));

  queue = [{ name: "ToolSearch", input: { names: ["Write"] } }, { text: "Unavailable in child scope." }];
  const child = query({ messages: [{ role: "user", content: "Scope test" }], model: "fixture", tools: [toolToApiParam(toolSearchTool), toolToApiParam(findToolByName("Read")!)], toolContext: { cwd, discoverTools: discovery.discover.bind(discovery) }, maxTurns: 3 });
  let childResult = await child.next();
  while (!childResult.done) childResult = await child.next();
  assert.equal(childResult.value.reason, "completed");
  assert.ok(childResult.value.state.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result" && String(block.content).includes("unavailable in this scope"))), "a child invocation overrides any inherited parent discovery callback");

  queue = [{ name: "ToolSearch", input: { names: ["Edit"] } }, { text: "No discovery in this scope." }];
  const noDiscoveryChild = query({ messages: [{ role: "user", content: "Restricted child" }], model: "fixture", tools: [toolToApiParam(findToolByName("Read")!)], toolContext: { cwd, discoverTools: discovery.discover.bind(discovery) }, maxTurns: 3 });
  let narrowResult = await noDiscoveryChild.next();
  while (!narrowResult.done) narrowResult = await noDiscoveryChild.next();
  assert.equal(narrowResult.value.reason, "completed");
  assert.ok(narrowResult.value.state.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result" && String(block.content).includes("was not loaded"))), "explicit child scopes without ToolSearch cannot invoke an inherited discovery capability");

  const diagnosticEvents = [];
  for await (const event of engine.submitMessage("/context")) diagnosticEvents.push(event);
  const contextOutput = diagnosticEvents.filter(event => event.type === "command").map(event => event.message).join("\n");
  assert.ok(contextOutput.includes(`Tool definitions loaded: ${engine.getModelTools().length}/${getToolsApiParams().length}`), "context diagnostics use the current discovery selection");
  const loadedTokens = Math.round(JSON.stringify(engine.getModelTools()).length / 2).toLocaleString("en-US");
  assert.match(contextOutput, new RegExp(`Tool definitions[^\\n]*${loadedTokens} tok`), "context token estimates reflect only loaded schemas");

  const targetId = "discovery-resume-target";
  const timestamp = new Date().toISOString();
  await initSessionStorage({ sessionId: targetId, cwd, startedAt: timestamp, updatedAt: timestamp, model: "fixture" });
  const savedMessages = [
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "saved-discovery", name: "ToolSearch", input: { names: ["Edit"] } }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "saved-discovery", content: JSON.stringify({ type: "tool_discovery", loaded: ["Edit"] }) }] },
  ];
  for (const message of savedMessages) await appendTranscriptEntry(cwd, targetId, { type: "message", timestamp, role: message.role, message });
  let switched = false;
  for await (const event of engine.submitMessage(`/resume ${targetId}`)) if (event.type === "session_switched") switched = true;
  assert.ok(switched, "the real resume command switches to the saved session");
  assert.deepEqual(new Set(engine.getModelTools().map(tool => tool.name)), new Set([...CORE_TOOL_NAMES, "Edit"]), "resume restores the target selection and drops tools from the previous session");

  for await (const _event of engine.submitMessage("/clear")) { /* Local command. */ }
  assert.deepEqual(new Set(engine.getModelTools().map((tool) => tool.name)), CORE_TOOL_NAMES, "/clear starts with only core definitions again");
  console.log("Tool discovery checks passed: bounded/default payload, bilingual discovery, lazy real schemas, MCP dispatch, permission/agent boundaries, disabled tools, session retention/resume/clear.");
} finally {
  clearMcpTools();
  globalThis.fetch = originalFetch;
  process.chdir(previousCwd);
  await account.close();
  if (previousHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = previousHome;
  resetSettingsCache();
  await fs.rm(root, { recursive: true, force: true });
}
