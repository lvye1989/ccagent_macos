/** Model list, selection, Omni fallback configuration, and Qwen tool-history regressions. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { loadProfiles, resolveProfile, loadModelRoles } from "../services/api/providers/profile.js";
import { getQwenOmniModel, qwenOmniEnvironmentProfile } from "../services/api/providers/modelConfig.js";
import { resolveVisionProfile } from "../services/vision/analyzeImage.js";
import { prepareRequest } from "../services/api/providers/providerStream.js";
import { QueryEngine } from "../core/queryEngine.js";
import { loginForTest } from "./helpers/accountFixture.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-model-config-"));
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const account = await loginForTest(path.join(root, "user"));
const keys = /^(QWEN_|DASHSCOPE_|DEEPSEEK_|OLLAMA_)/;
let checks = 0;
function check(value: unknown, label: string): void { assert.ok(value, label); checks++; console.log(`  [PASS] ${label}`); }
function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const resolvedArgs = args.map((arg, index) => args[index - 1] === "--import" && arg === "tsx" ? import.meta.resolve("tsx") : arg);
    const child = execFile(process.execPath, resolvedArgs, { cwd: root, env: process.env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      resolve({ status: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr });
    });
    child.stdin?.end();
  });
}
try {
  for (const key of Object.keys(process.env)) if (keys.test(key)) delete process.env[key];
  Object.assign(process.env, {
    DEEPSEEK_MODEL: "deepseek-fixture", DEEPSEEK_BASE_URL: "https://deepseek.invalid",
    OLLAMA_MODEL: "local-qwen-fixture", OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
    QWEN_MODEL: "qwen3.8-max, qwen3.8-flash,qwen3.8-max",
    QWEN_OMNI_MODEL: "qwen3.8-omni-flash", QWEN_PROTOCOL: "openai-chat",
    DASHSCOPE_BASE_URL: "https://qwen.invalid/v1", DASHSCOPE_API_KEY: "TEST_ONLY",
  });
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(account.origin + "/")) return savedFetch(url, init);
    throw new Error("Local model menus must not call a provider");
  };
  await fs.mkdir(account.home, { recursive: true });
  await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify({
    models: { "qwen-omni": { protocol: "openai-chat", model: "${QWEN_MODEL:-qwen3.8-omni-flash}", baseURL: "${DASHSCOPE_BASE_URL}", apiKey: "${DASHSCOPE_API_KEY}", maxTokens: 4096 } },
    modelRoles: { computerUse: "qwen-omni", image: "qwen-omni", multimodal: "qwen-omni" },
  }));
  const { profiles } = await loadProfiles(root);
  check(profiles.deepseek.model === "deepseek-fixture" && profiles.ollama.model === "local-qwen-fixture", "DeepSeek and Ollama environment models appear in the catalog");
  check(profiles.qwen.model === "qwen3.8-max" && profiles["qwen3.8-flash"].model === "qwen3.8-flash", "Qwen list creates separate Max/Flash choices without duplicate names");
  check(Object.values(profiles).every((p) => !p.model.includes(",")), "Every upstream request uses exactly one model name");
  check((await resolveProfile("qwen3.8-max", root)).id === "qwen" && (await resolveProfile("local-qwen-fixture", root)).id === "ollama", "Selecting an upstream model name resolves to its provider instead of Anthropic");
  check(profiles["qwen-omni"].model === "qwen3.8-omni-flash" && profiles["qwen-omni"].maxTokens === 4096, "Legacy Omni profile references migrate without changing its output limit");
  check((await resolveVisionProfile(root, "deepseek"))?.model === "qwen3.8-omni-flash" && qwenOmniEnvironmentProfile("computer")?.model === "qwen3.8-omni-flash", "Text-only main models use the configured Omni fallback");
  check((await resolveVisionProfile(root, "qwen"))?.model === "qwen3.8-max", "An image-capable Qwen main model takes precedence over Omni roles");
  const roles = await loadModelRoles(root);
  const actions = ["qwen", "仅当前会话", "下一页", "qwen3.8-flash", "仅当前会话", "恢复默认模型", null];
  const selected: string[] = [];
  let questions = 0;
  const engine = new QueryEngine({ model: "ollama", toolContext: { cwd: root, requestUserQuestion: async (request) => {
    assert.ok(questions < actions.length, "Model picker must exit on cancellation");
    const action = actions[questions++];
    const q = request.questions[0];
    assert.ok(q.options.length <= 4);
    if (action === null) return null;
    const choice = q.options.find((o) => o.label === action || o.label.endsWith(` · ${action}`));
    assert.ok(choice, `Missing model choice ${action}`);
    return { answers: { [q.question]: choice.label } };
  } } });
  for await (const event of engine.submitMessage("/model")) {
    assert.ok(event.type === "command" || event.type === "model_changed");
    if (event.type === "model_changed") selected.push(event.model);
  }
  check(selected.join(",") === "qwen,qwen3.8-flash,ollama" && questions === actions.length, "One local /model menu selects Max, Flash, then restores the default model");
  assert.deepEqual(await loadModelRoles(root), roles);
  check((await resolveVisionProfile(root, "deepseek"))?.model === "qwen3.8-omni-flash", "Main-model selection preserves the configured fallback for text-only models");

  const settingsPath = path.join(account.home, "settings.json");
  const priorSettings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const saveActions = ["deepseek", "保存为默认", "qwen", "仅当前会话", "下一页", "恢复默认模型", null];
  let saveQuestion = 0;
  const savingEngine = new QueryEngine({ model: "ollama", toolContext: { cwd: root, requestUserQuestion: async ({ questions }) => {
    const q = questions[0];
    assert.ok(saveQuestion < saveActions.length && q.options.length <= 4);
    const action = saveActions[saveQuestion++];
    if (action === null) return null;
    const option = q.options.find((o) => o.label === action || o.label.endsWith(` · ${action}`));
    assert.ok(option, `Missing save choice: ${action}`);
    return { answers: { [q.question]: option.label } };
  } } });
  for await (const event of savingEngine.submitMessage("/model")) if (event.type === "command") assert.notEqual(event.kind, "error", event.message);
  const savedSettings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  check(savedSettings.defaultModel === "deepseek" && savingEngine.getState().model === "deepseek" && savingEngine.getState().modelSource === "default", "The real /model picker saves DeepSeek, allows a temporary switch, and restores the new persistent default");
  assert.deepEqual(savedSettings, { ...priorSettings, defaultModel: "deepseek" });
  check(saveQuestion === saveActions.length, "Saving a default preserves unrelated settings and keeps the model menu open");
  for await (const event of savingEngine.submitMessage("/model save qwen3.8-flash")) if (event.type === "command") assert.notEqual(event.kind, "error");
  check(JSON.parse(await fs.readFile(settingsPath, "utf8")).defaultModel === "qwen3.8-flash", "Direct save resolves an upstream model name to a persistent configured profile");
  const beforeCancel = await fs.readFile(settingsPath, "utf8");
  const cancelled = ["deepseek", null, null];
  let cancelIndex = 0;
  const cancelEngine = new QueryEngine({ model: "qwen3.8-flash", toolContext: { cwd: root, requestUserQuestion: async ({ questions }) => {
    const q = questions[0];
    assert.ok(cancelIndex < cancelled.length);
    const action = cancelled[cancelIndex++];
    if (action === null) return null;
    return { answers: { [q.question]: q.options.find((o) => o.label.endsWith(` · ${action}`))!.label } };
  } } });
  for await (const _ of cancelEngine.submitMessage("/model")) {}
  check(await fs.readFile(settingsPath, "utf8") === beforeCancel && cancelEngine.getState().model === "qwen3.8-flash", "Cancelling the persistence decision changes neither the model nor settings");

  const cli = fileURLToPath(new URL("../entrypoint/cli.ts", import.meta.url));
  const restarted = await runCli(["--import", "tsx", cli, "--print", "/model list", "--output-format", "json"]);
  assert.equal(restarted.status, 0, restarted.stderr);
  check(JSON.parse(restarted.stdout.trim()).result.includes("qwen3.8-flash (active) (default)"), "A new CLI process loads the saved default without a --model argument");
  const validSettings = await fs.readFile(settingsPath, "utf8");
  await fs.writeFile(settingsPath, "{ invalid json");
  const failed: string[] = [];
  for await (const event of savingEngine.submitMessage("/model save deepseek")) if (event.type === "command" && event.kind === "error") failed.push(event.message);
  check(failed.length === 1 && await fs.readFile(settingsPath, "utf8") === "{ invalid json", "Saving refuses malformed user settings without overwriting them");
  await fs.writeFile(settingsPath, validSettings);
  const list = await runCli(["--import", "tsx", cli, "--print", "/model list", "--output-format", "json"]);
  assert.equal(list.status, 0, list.stderr);
  const listing = JSON.parse(list.stdout.trim());
  check(listing.subtype === "success" && listing.num_turns === 0 && ["qwen3.8-max", "qwen3.8-flash", "qwen3.8-omni-flash", "deepseek-fixture", "local-qwen-fixture"].every((m) => listing.result.includes(m)), "Real headless /model list prints all configured choices and succeeds without inference");
  const invalid = await runCli(["--import", "tsx", cli, "--print", "/not-a-command", "--output-format", "json"]);
  check(invalid.status === 1 && JSON.parse(invalid.stdout.trim()).is_error === true, "Headless command errors retain a failing exit code");

  const history = [
    { role: "user", content: "Use Echo" },
    { role: "assistant", content: [{ type: "thinking", thinking: "exact reasoning", signature: "fixture" }, { type: "tool_use", id: "call_1", name: "Echo", input: { text: "ok" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
  ];
  for (const model of ["qwen3.8-max", "qwen3.8-flash"]) {
    const profile = await resolveProfile(model, root);
    const request = prepareRequest(profile, { messages: history as never, thinking: { type: "adaptive" }, effortLevel: "high" });
    const messages = request.body.messages as Array<Record<string, unknown>>;
    check(messages.find((m) => m.role === "assistant")?.reasoning_content === "exact reasoning" && messages.some((m) => m.tool_call_id === "call_1"), `${model} preserves reasoning and tool-result pairing`);
    assert.equal(request.body.reasoning_effort, "xhigh");
    const off = prepareRequest(profile, { messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" }, effortLevel: "high" });
    check(off.body.enable_thinking === false && off.body.reasoning_effort === "none", `${model} honors /think off even with a configured effort`);
  }
  const omni = prepareRequest(profiles["qwen-omni"], { messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } });
  check(omni.body.reasoning_effort === "none" && omni.body.enable_thinking === undefined, "Omni honors explicit thinking-off requests with the upstream none value");
  delete process.env.QWEN_OMNI_MODEL;
  process.env.QWEN_MODEL = "qwen3.8-omni-flash";
  check(getQwenOmniModel() === "qwen3.8-omni-flash", "Legacy QWEN_MODEL Omni configuration remains compatible");
  process.env.QWEN_MODEL = "qwen3.8-max,qwen3.8-flash";
  check(getQwenOmniModel() === undefined, "Main-model lists do not redefine the Omni fallback");
  process.env.DEEPSEEK_MODEL = "deepseek-a,deepseek-b";
  process.env.OLLAMA_MODEL = "local-a,local-b";
  const expanded = (await loadProfiles(root)).profiles;
  check(expanded["deepseek-b"].protocol === "openai-responses" && expanded["local-b"].baseURL === process.env.OLLAMA_BASE_URL, "DeepSeek/Ollama list entries inherit their own protocol and endpoint");
  console.log(`\nAll ${checks} model configuration checks passed (loopback account only; no provider calls).`);
} finally {
  globalThis.fetch = savedFetch;
  await account.close();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await fs.rm(root, { recursive: true, force: true });
}
