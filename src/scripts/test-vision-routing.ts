/** Wire-level regressions for native vision vs text + Omni across image entry points. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import type { ImageBlock } from "../types/message.js";
import { loadProfiles, resolveProfile } from "../services/api/providers/profile.js";
import { modelSupportsImages } from "../services/vision/capabilities.js";
import { analyzeImageFile, prepareMessagesForVision, resolveVisionProfile } from "../services/vision/analyzeImage.js";
import { createMessage, streamMessage } from "../services/api/streaming.js";
import { buildObservationResult } from "../tools/computerUseTools.js";
import { QueryEngine } from "../core/queryEngine.js";
import { loginForTest } from "./helpers/accountFixture.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-vision-routing-"));
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const account = await loginForTest(path.join(root, "home"));
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
let checks = 0;
let emptyVision = false;
function check(value: unknown, label: string): void { assert.ok(value, label); checks++; console.log(`  [PASS] ${label}`); }
const image: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE3sAAAAASUVORK5CYII=" } };
const messages = [{ role: "user", content: [{ type: "text", text: "Describe this image" }, image] }] as MessageParam[];
const hasWireImage = (value: unknown): boolean => JSON.stringify(value).includes('"type":"image_url"');
const profile = (id: string, model: string, extra: Partial<ModelProfile> = {}): ModelProfile => ({ id, model, protocol: "openai-chat", baseURL: "https://main.invalid/v1", ...extra });

try {
  for (const key of Object.keys(process.env)) if (/^(QWEN_|DASHSCOPE_|DEEPSEEK_|OLLAMA_|CCAGENT_ENV_FILE)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    CCAGENT_HOME: account.home, CCAGENT_MAX_RETRIES: "0",
    QWEN_MODEL: "qwen3.8-max,qwen-vl-plus", QWEN_OMNI_MODEL: "qwen3.8-omni-flash",
    DASHSCOPE_BASE_URL: "https://omni.invalid/v1", DASHSCOPE_API_KEY: "TEST_ONLY",
  });
  await fs.mkdir(process.env.CCAGENT_HOME!, { recursive: true });
  const settingsPath = path.join(process.env.CCAGENT_HOME!, "settings.json");
  const settings = {
    defaultModel: "text",
    models: {
      text: profile("text", "qwen-plus"),
      plus: profile("plus", "qwen3.7-plus"),
      custom: profile("custom", "private-multimodal", { supportsVision: true }),
      forcedText: profile("forcedText", "qwen3.8-max", { supportsVision: false }),
      legacyVision: profile("legacyVision", "custom-perception"),
    },
    modelRoles: { image: "legacyVision", computerUse: "legacyVision" },
  };
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith(account.origin + "/")) return savedFetch(input, init);
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/api/show")) {
      return Response.json({ capabilities: body.model === "local-vision" ? ["completion", "vision"] : ["completion"] });
    }
    const model = String(body.model);
    const text = model.includes("omni") ? (emptyVision ? "" : "VISUAL_EVIDENCE: a small white square") : "MAIN_RESPONSE";
    return new Response([
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  check(!await modelSupportsImages(await resolveProfile("text", root)) && await modelSupportsImages(await resolveProfile("plus", root)), "Older qwen-plus is text-only; Qwen3.7 Plus accepts images");
  check(await modelSupportsImages(await resolveProfile("custom", root)) && !await modelSupportsImages(await resolveProfile("forcedText", root)), "Explicit profile capability overrides model-name inference in both directions");
  check((await loadProfiles(root)).profiles["qwen-vl-plus"].model === "qwen-vl-plus", "Multimodal models in QWEN_MODEL remain selectable as main models");
  check((await resolveVisionProfile(root, "text"))?.model === "qwen3.8-omni-flash" && (await resolveVisionProfile(root, "plus"))?.id === "plus", "The active model takes precedence over configured Omni and task roles when image-capable");

  const original = JSON.stringify(messages);
  await createMessage({ model: "text", cwd: root, messages });
  check(requests.length === 2 && requests[0].body.model === "qwen3.8-omni-flash" && requests[1].body.model === "qwen-plus", "Text plus Omni uses a perception request followed by the original main model");
  check(hasWireImage(requests[0].body) && !hasWireImage(requests[1].body) && JSON.stringify(requests[1].body).includes("VISUAL_EVIDENCE"), "Only Omni receives image bytes; the text-only reasoner receives visual evidence");
  check(JSON.stringify(messages) === original, "Routing preserves original image history for later model switches");
  requests.length = 0;
  await createMessage({ model: "text", cwd: root, messages });
  check(requests.length === 1 && requests[0].body.model === "qwen-plus", "Historical image evidence is cached across reasoning calls");

  requests.length = 0;
  for await (const event of streamMessage({ model: "plus", cwd: root, messages })) assert.notEqual(event.type, "error");
  check(requests.length === 1 && requests[0].body.model === "qwen3.7-plus" && hasWireImage(requests[0].body), "Multimodal streaming sends the original image directly to the selected main model without Omni");
  requests.length = 0;
  const history = [
    { role: "assistant", content: [{ type: "tool_use", id: "read_1", name: "Read", input: { file_path: "image.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read_1", content: [{ type: "text", text: "Read image" }, image] }] },
  ] as MessageParam[];
  await createMessage({ model: "text", cwd: root, messages: history });
  check(!hasWireImage(requests[0].body) && JSON.stringify(requests[0].body).includes("read_1") && JSON.stringify(requests[0].body).includes("VISUAL_EVIDENCE"), "Read/MCP nested tool images become evidence while preserving tool-result pairing");

  const capture = path.join(root, "capture.png");
  await fs.writeFile(capture, Buffer.from(image.source.type === "base64" ? image.source.data : "", "base64"));
  requests.length = 0;
  check((await analyzeImageFile(capture, "Rhino QA", root, undefined, "plus")).model === "plus" && requests.length === 1 && requests[0].body.model === "qwen3.7-plus", "Rhino visual analysis uses the active multimodal model");
  requests.length = 0;
  check((await analyzeImageFile(capture, "Rhino QA", root, undefined, "text")).model === "qwen-vision" && requests[0].body.model === "qwen3.8-omni-flash", "Rhino visual analysis pairs a text-only main model with Omni");

  const snapshot = { id: "snapshot", createdAt: Date.now(), observation: {
    window: { id: "window", processId: 1, processName: "safari", title: "Fixture" },
    width: 100, height: 100, nativeWidth: 100, nativeHeight: 100, elements: [], screenshot: Buffer.from("fixture"), mediaType: "image/jpeg" as const,
  } };
  requests.length = 0;
  const nativeObservation = await buildObservationResult(snapshot, {}, { cwd: root, defaultModel: "plus" });
  check(requests.length === 0 && Array.isArray(nativeObservation.content) && nativeObservation.content.some((b) => b.type === "image"), "Computer Use automatically returns screenshots directly to a multimodal main model without a perception call");
  const pairedObservation = await buildObservationResult(snapshot, {}, { cwd: root, defaultModel: "text" });
  check(requests.length === 1 && requests[0].body.model === "qwen3.8-omni-flash" && typeof pairedObservation.content === "string" && pairedObservation.content.includes("VISUAL_EVIDENCE"), "Computer Use automatically returns only Omni evidence to a text-only main model");
  requests.length = 0;
  await buildObservationResult(snapshot, { perception: "on" }, { cwd: root, defaultModel: "plus" });
  check(requests.length === 1 && requests[0].body.model === "qwen3.7-plus", "Explicit perception after switching models uses the current multimodal main model instead of cached Omni evidence");
  requests.length = 0;
  await buildObservationResult({ ...snapshot, id: "snapshot2" }, { perception: "off", image_delivery: "text_only" }, { cwd: root, defaultModel: "ollama" });
  check(requests.length === 0, "Local-only Computer Use feedback performs no model capability probes or perception calls");

  const local = (model: string) => profile("ollama", model, { baseURL: "http://127.0.0.1:11434/v1" });
  requests.length = 0;
  check(!await modelSupportsImages(local("qwen3.8:27b-mtp-q8_0")) && await modelSupportsImages(local("local-vision")), "Ollama metadata distinguishes deployed text-only and vision-capable models");
  await modelSupportsImages(local("local-vision"));
  check(requests.length === 2 && requests.every((r) => r.url.endsWith("/api/show")), "Ollama capability results are cached and no inference is used for detection");
  check(!await modelSupportsImages({ ...local("local-vision"), supportsVision: false }) && requests.length === 2, "Explicit Ollama override avoids a metadata request");
  process.env.OLLAMA_MODEL = "local-vision";
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
  process.env.OLLAMA_SUPPORTS_VISION = "false";
  check(!await modelSupportsImages(await resolveProfile("ollama", root)) && requests.length === 2, "The Ollama environment capability override is respected without probing");
  delete process.env.OLLAMA_SUPPORTS_VISION;

  const engine = new QueryEngine({ model: "text", toolContext: { cwd: root } });
  requests.length = 0;
  for await (const event of engine.submitMessage(`Describe @${capture}`)) assert.notEqual(event.type, "error");
  check(engine.getState().model === "text" && requests.at(-1)?.body.model === "qwen-plus", "Attaching an image preserves the text main model instead of switching the entire turn to Omni");
  for await (const event of engine.submitMessage("/model plus")) assert.notEqual(event.type, "error");
  requests.length = 0;
  for await (const event of engine.submitMessage(`Describe again @${capture}`)) assert.notEqual(event.type, "error");
  check(engine.getState().model === "plus" && requests.length === 1 && requests[0].body.model === "qwen3.7-plus" && hasWireImage(requests[0].body), "A /model switch immediately changes image routing, including original images already in history");

  process.env.QWEN_SUPPORTS_VISION = "false";
  check((await resolveVisionProfile(root, "qwen"))?.model === "qwen3.8-omni-flash", "The Qwen environment override can force a custom text-only deployment to pair with Omni");
  delete process.env.QWEN_SUPPORTS_VISION;
  requests.length = 0;
  const aborted = AbortSignal.abort();
  await assert.rejects(prepareMessagesForVision(messages, await resolveProfile("text", root), root, aborted), { name: "AbortError" });
  check(requests.length === 0, "Cancellation stops visual preprocessing before a provider request");
  emptyVision = true;
  const different = [{ role: "user", content: [{ ...image, source: { type: "url", url: "https://example.invalid/uncached.png" } }] }] as MessageParam[];
  await assert.rejects(createMessage({ model: "text", cwd: root, messages: different }), /no text evidence/);
  check(requests.length === 1 && requests[0].body.model === "qwen3.8-omni-flash", "Failed perception never sends unsupported image bytes to the text main model");
  delete process.env.QWEN_OMNI_MODEL;
  emptyVision = false;
  requests.length = 0;
  await createMessage({ model: "text", cwd: root, messages });
  check(requests.length === 2 && requests[0].body.model === "custom-perception" && requests[1].body.model === "qwen-plus", "Configured modelRoles remain a usable fallback when no Omni environment model is set");
  await fs.writeFile(settingsPath, JSON.stringify({ ...settings, modelRoles: {} }));
  requests.length = 0;
  await assert.rejects(createMessage({ model: "text", cwd: root, messages }), /cannot receive images/);
  check(requests.length === 0, "Missing vision configuration fails explicitly without calling the text provider");
  console.log(`\nAll ${checks} vision routing checks passed (mocked providers; no real API calls).`);
} finally {
  globalThis.fetch = savedFetch;
  await account.close();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await fs.rm(root, { recursive: true, force: true });
}
