/** Global audio skill, file ingestion and actual provider-wire routing with mocked APIs. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { AudioBlock } from "../types/message.js";
import { bootstrapSkills } from "../services/skills/bootstrap.js";
import { findSkill, clearSkills, getInstalledSkills, setSkills } from "../services/skills/registry.js";
import { AUDIO_SKILL_NAME, AUDIO_SKILL_MARKDOWN, ensureBuiltinSkills } from "../services/skills/builtins.js";
import { LEGACY_AUDIO_SKILL_NAME } from "../services/skills/names.js";
import { bootstrapAgentSkills, setAgentSkillsEnabled, getSkillState, setSkillState, isSkillEnabled } from "../utils/agentSkillsEnabled.js";
import { classifyUserInput } from "../ui/hooks/useAgentSession/inputClassification.js";
import { readAudioAsBlock, isAudioPath, parsePastedAudioPath, MAX_AUDIO_BYTES } from "../tools/audioUtils.js";
import { buildUserMessageContent } from "../core/attachImages.js";
import { addPastedAudio, audioRefToken } from "../core/pastedAudio.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { skillTool } from "../tools/skillTool.js";
import { toolResultText } from "../tools/Tool.js";
import { createMessage, streamMessage } from "../services/api/streaming.js";
import { QueryEngine } from "../core/queryEngine.js";
import { estimateMessageTokens } from "../utils/tokens.js";
import { loginForTest } from "./helpers/accountFixture.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-audio-skill-"));
const oldEnv = { ...process.env };
const oldFetch = globalThis.fetch;
const account = await loginForTest(path.join(root, "home"));
let checks = 0;
let emptyAudio = false;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; console.log(`  [PASS] ${label}`); };
const wav = Buffer.alloc(44 + 1600 * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 1600; i++) wav.writeInt16LE(Math.round(Math.sin(i * 0.17) * 8000), 44 + i * 2);
const file = path.join(root, "voice memo.wav");
const messagesFor = (audio: AudioBlock): MessageParam[] => [{ role: "user", content: [{ type: "text", text: "Transcribe this recording" }, audio] }] as unknown as MessageParam[];
const hasAudio = (value: unknown) => JSON.stringify(value).includes('"type":"input_audio"');

try {
  for (const key of Object.keys(process.env)) if (/^(QWEN_|DASHSCOPE_|OLLAMA_|DEEPSEEK_|CCAGENT_ENV_FILE)/.test(key)) delete process.env[key];
  Object.assign(process.env, { CCAGENT_HOME: account.home, CCAGENT_MAX_RETRIES: "0", CCAGENT_DISABLE_HOOKS: "1",
    QWEN_OMNI_MODEL: "qwen3.8-omni-flash", QWEN_MODEL: "qwen3.8-max", DASHSCOPE_BASE_URL: "https://omni.invalid/v1", DASHSCOPE_API_KEY: "TEST_ONLY" });
  await fs.mkdir(process.env.CCAGENT_HOME!, { recursive: true });
  const settingsPath = path.join(process.env.CCAGENT_HOME!, "settings.json");
  const oldDir = path.join(process.env.CCAGENT_HOME!, "skills", LEGACY_AUDIO_SKILL_NAME);
  const newDir = path.join(process.env.CCAGENT_HOME!, "skills", AUDIO_SKILL_NAME);
  const legacy = AUDIO_SKILL_MARKDOWN.replace("name: read-audio", "name: read_audio.skill") + "\nUser legacy customization.\n";
  await fs.mkdir(path.join(oldDir, "references"), { recursive: true });
  const outsideSkill = path.join(root, "outside-SKILL.md");
  await fs.writeFile(outsideSkill, legacy);
  await fs.symlink(outsideSkill, path.join(oldDir, "SKILL.md"));
  check((await ensureBuiltinSkills()).some((warning) => warning.includes("symlinked")) && await fs.readFile(outsideSkill, "utf8") === legacy
    && !await fs.stat(newDir).then(() => true).catch(() => false), "Migration refuses a symlinked definition without modifying its external target");
  await fs.unlink(path.join(oldDir, "SKILL.md"));
  await fs.writeFile(path.join(oldDir, "SKILL.md"), legacy);
  await fs.writeFile(path.join(oldDir, "references", "custom.txt"), "Keep this resource");
  await fs.writeFile(settingsPath, JSON.stringify({ agentSkills: true, unrelated: "keep", skillStates: { [LEGACY_AUDIO_SKILL_NAME]: "close" } }));
  await bootstrapAgentSkills(); await bootstrapSkills(root);
  check(await fs.readFile(path.join(newDir, "SKILL.md"), "utf8") === legacy.replace("name: read_audio.skill", "name: read-audio") && !await fs.stat(oldDir).then(() => true).catch(() => false)
    && await fs.readFile(path.join(newDir, "references", "custom.txt"), "utf8") === "Keep this resource", "Legacy installation migrates to a valid name and directory without changing custom content or resources");
  check(getInstalledSkills().filter((s) => s.name === AUDIO_SKILL_NAME).length === 1 && findSkill(LEGACY_AUDIO_SKILL_NAME) === findSkill(AUDIO_SKILL_NAME), "Legacy lookup resolves to the single canonical installed skill");
  check(!isSkillEnabled(AUDIO_SKILL_NAME) && !classifyUserInput('/read_audio.skill').isLlmTriggering && (await skillTool.call({ skill: LEGACY_AUDIO_SKILL_NAME }, { cwd: root })).isError, "Legacy Close setting applies to the renamed skill and both invocation paths");
  await setSkillState(LEGACY_AUDIO_SKILL_NAME, "open");
  const migratedSettings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  check(migratedSettings.skillStates[AUDIO_SKILL_NAME] === "open" && !Object.hasOwn(migratedSettings.skillStates, LEGACY_AUDIO_SKILL_NAME) && migratedSettings.unrelated === "keep", "Updating an alias persists the canonical preference and preserves unrelated settings");
  const canonicalSkill = findSkill(AUDIO_SKILL_NAME)!;
  setSkills([canonicalSkill, { ...canonicalSkill, name: LEGACY_AUDIO_SKILL_NAME, body: "Old duplicate" }]);
  check(findSkill(AUDIO_SKILL_NAME)?.body !== "Old duplicate" && getInstalledSkills().length === 1, "An existing canonical installation takes precedence over a legacy duplicate");
  await fs.rm(newDir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ skillStates: { [LEGACY_AUDIO_SKILL_NAME]: "deleted" } }));
  await bootstrapAgentSkills(); await bootstrapSkills(root);
  check(!findSkill(AUDIO_SKILL_NAME) && getSkillState(AUDIO_SKILL_NAME) === "deleted", "A legacy Deleted preference prevents reinstalling the renamed built-in skill");
  await fs.writeFile(path.join(process.env.CCAGENT_HOME!, "settings.json"), JSON.stringify({ models: {
    text: { protocol: "openai-chat", model: "qwen-plus", baseURL: "https://main.invalid/v1" },
    multimodal: { protocol: "openai-chat", model: "qwen3.8-max", baseURL: "https://main.invalid/v1" },
  } }));
  await bootstrapAgentSkills();
  await bootstrapSkills(root);
  const skill = findSkill(AUDIO_SKILL_NAME)!;
  check(skill?.source === "user" && skill.filePath === await fs.realpath(path.join(process.env.CCAGENT_HOME!, "skills", AUDIO_SKILL_NAME, "SKILL.md")), "Application installs a real user-global read-audio skill at startup");
  check(skill.body.includes("QWEN_OMNI_MODEL") && skill.frontmatter.allowedTools.join(",") === "Read", "Global skill uses Omni through Read without granting shell access");
  const existing = await fs.readFile(skill.filePath, "utf8") + "\nUser customization.\n";
  await fs.writeFile(skill.filePath, existing);
  await bootstrapSkills(path.join(root, "another-project"));
  check(await fs.readFile(skill.filePath, "utf8") === existing && findSkill(AUDIO_SKILL_NAME)?.body.includes("User customization"), "Global skill is available across projects and existing user customizations survive startup");
  check(!(await skillTool.call({ skill: AUDIO_SKILL_NAME, args: "recording.wav" }, { cwd: root })).isError, "The normal Skill tool can invoke the bundled audio skill");

  await fs.writeFile(file, wav);
  check(isAudioPath("recording.MP3") && isAudioPath("voice.m4a") && !isAudioPath("source.ts"), "Audio detection supports common formats without hijacking source files");
  check(parsePastedAudioPath(`'${file}'`) === file && parsePastedAudioPath(file.replace(/ /g, "\\ ")) === file && parsePastedAudioPath(`file://${file.replace(/ /g, "%20")}`) === file, "Quoted, Finder-escaped and file-URL audio paths are recognized");
  const loaded = await readAudioAsBlock(file);
  assert.ok(loaded.ok);
  check(Buffer.from(loaded.block.source.data, "base64").equals(wav) && loaded.block.source.format === "wav", "Audio files are preserved as binary media instead of UTF-8 text");
  const attached = await buildUserMessageContent(`Read @"${file}" and @${file.replace(/ /g, "\\ ")}`, root);
  check(attached.attached.length === 1 && attached.attached[0].kind === "audio" && Array.isArray(attached.content) && attached.content.some((b) => b.type === "audio"), "Quoted and escaped @audio references attach once and preserve the original prompt");
  const pasted = addPastedAudio({ ...loaded, filename: "uploaded.wav" });
  check((await buildUserMessageContent(audioRefToken(pasted), root)).attached[0]?.kind === "audio" && (await buildUserMessageContent(audioRefToken(pasted), root)).errors.length === 1, "Audio upload chips expand once through the shared attachment pipeline");
  const read = await fileReadTool.call({ file_path: file }, { cwd: root });
  check(!read.isError && Array.isArray(read.content) && read.content.some((b) => b.type === "audio") && toolResultText(read.content).includes("[audio]"), "Read returns typed audio media and UI summaries omit raw bytes");
  const large = path.join(root, "large.wav");
  const largeHandle = await fs.open(large, "w"); await largeHandle.truncate(MAX_AUDIO_BYTES + 1); await largeHandle.close();
  check(!(await readAudioAsBlock(large)).ok, "Oversized audio is rejected before base64 encoding or provider calls");
  const empty = path.join(root, "empty.wav"); await fs.writeFile(empty, "");
  check(!(await readAudioAsBlock(empty)).ok && !(await readAudioAsBlock(path.join(root, "missing.wav"))).ok, "Empty and missing recordings produce clear local errors");
  await fs.symlink(os.tmpdir(), path.join(root, "outside"));
  check((await buildUserMessageContent("Read @outside/unapproved.wav", root)).errors.some((e) => e.includes("outside")), "Typed audio references cannot escape allowed roots through symlinks");

  if (process.platform === "darwin") {
    const m4a = path.join(root, "recording.m4a");
    await promisify(execFile)("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", file, m4a]);
    const converted = await readAudioAsBlock(m4a);
    check(converted.ok && converted.block.source.format === "wav" && Buffer.from(converted.block.source.data, "base64").subarray(0, 4).toString() === "RIFF", "macOS voice-memo M4A files are converted into real WAV audio");
  }

  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith(account.origin + "/")) return oldFetch(input, init);
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(input), body });
    const text = hasAudio(body) ? (emptyAudio ? "" : "AUDIO_TRANSCRIPT: hello from the recording") : "MAIN_RESPONSE";
    return new Response(`data: ${JSON.stringify({ id: "audio-fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "audio-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const audioMessages = messagesFor(loaded.block);
  await createMessage({ model: "text", cwd: root, messages: audioMessages });
  check(calls.length === 2 && calls[0].url === "https://omni.invalid/v1/chat/completions" && calls[0].body.model === "qwen3.8-omni-flash" && calls[1].body.model === "qwen-plus", "Uploaded audio is read by configured Omni before returning to the selected text main model");
  const first = calls[0].body as { modalities: string[]; messages: Array<{ content: Array<{ type: string; input_audio?: { data: string; format: string } }> }> };
  const inputAudio = first.messages[0].content.find((part) => part.type === "input_audio")?.input_audio;
  check(inputAudio?.format === "wav" && inputAudio.data === `data:audio/wav;base64,${wav.toString("base64")}` && first.modalities.join(",") === "text", "Omni receives the official input_audio data URI and requests text-only output");
  check(!hasAudio(calls[1].body) && JSON.stringify(calls[1].body).includes("AUDIO_TRANSCRIPT"), "The main model receives recognized audio evidence, never unsupported audio bytes");
  calls.length = 0;
  await createMessage({ model: "multimodal", cwd: root, messages: messagesFor((await readAudioAsBlock(file) as typeof loaded).block) });
  check(calls.length === 1 && calls[0].body.model === "qwen3.8-max" && !hasAudio(calls[0].body), "Image-capable main models also use cached Omni evidence instead of receiving audio");
  const persisted = JSON.parse(JSON.stringify(audioMessages)) as MessageParam[];
  calls.length = 0;
  await setAgentSkillsEnabled(false);
  await createMessage({ model: "text", cwd: root, messages: persisted });
  check(calls.length === 1 && calls[0].body.model === "qwen-plus", "Resumed conversations retain already completed audio evidence even after Skills is closed");
  const fresh = await readAudioAsBlock(file); assert.ok(fresh.ok);
  calls.length = 0;
  await assert.rejects(createMessage({ model: "text", cwd: root, messages: messagesFor(fresh.block) }), /agent-skill open/);
  check(calls.length === 0 && (await fileReadTool.call({ file_path: file }, { cwd: root })).isError, "Closing Skills blocks new audio recognition through both attachments and Read without network calls");
  await setAgentSkillsEnabled(true);

  calls.length = 0;
  const history = [
    { role: "assistant", content: [{ type: "tool_use", id: "read_audio_1", name: "Read", input: { file_path: file } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read_audio_1", content: read.content }] },
  ] as unknown as MessageParam[];
  for await (const event of streamMessage({ model: "multimodal", cwd: root, messages: history })) assert.notEqual(event.type, "error");
  check(calls.length === 1 && !hasAudio(calls[0].body) && JSON.stringify(calls[0].body).includes("read_audio_1") && JSON.stringify(calls[0].body).includes("AUDIO_TRANSCRIPT"), "Audio in Read tool results is converted before serialization and preserves tool-call pairing");
  check(estimateMessageTokens(audioMessages[0]) < 10_000 && estimateMessageTokens(history[1]) < 10_000, "Audio token estimates budget for transcript rather than raw base64 bytes");
  const engine = new QueryEngine({ model: "multimodal", toolContext: { cwd: root } });
  calls.length = 0;
  for (const name of [AUDIO_SKILL_NAME, LEGACY_AUDIO_SKILL_NAME]) {
    for await (const event of engine.submitMessage(`/${name} @"${file}" summarize`)) {
      assert.notEqual(event.type, "error");
      if (event.type === "command") assert.notEqual(event.kind, "error");
    }
    assert.ok(classifyUserInput(`/${name}`).isSkillCommand);
  }
  check(engine.getState().model === "multimodal" && calls.at(-1)?.body.model === "qwen3.8-max", "Both /read-audio and its legacy alias accept audio attachments and keep the user's main model");

  process.env.QWEN_OMNI_MODEL = "qwen-omni-audio-fixture";
  const uncached = await readAudioAsBlock(file); assert.ok(uncached.ok);
  calls.length = 0;
  await createMessage({ model: "multimodal", cwd: root, messages: messagesFor(uncached.block) });
  check(calls.length === 2 && calls[0].body.model === "qwen-omni-audio-fixture", "New audio reads follow QWEN_OMNI_MODEL rather than a hardcoded model name");
  calls.length = 0;
  await assert.rejects(createMessage({ model: "text", cwd: root, messages: messagesFor(fresh.block), signal: AbortSignal.abort() }), { name: "AbortError" });
  check(calls.length === 0, "Cancellation stops audio processing before sending a provider request");
  process.env.QWEN_OMNI_MODEL = "qwen-omni-empty-fixture";
  emptyAudio = true;
  await assert.rejects(createMessage({ model: "text", cwd: root, messages: messagesFor(fresh.block) }), /no audio transcript/);
  check(calls.length === 1 && hasAudio(calls[0].body), "Empty recognition fails explicitly without making the main model invent audio content");
  calls.length = 0;
  delete process.env.QWEN_OMNI_MODEL;
  await assert.rejects(createMessage({ model: "text", cwd: root, messages: messagesFor(fresh.block) }), /QWEN_OMNI_MODEL/);
  check(calls.length === 0, "Missing Omni configuration never redirects audio to a text/vision-only main model");
  console.log(`\nAll ${checks} global audio skill checks passed (mocked providers).`);
} finally {
  globalThis.fetch = oldFetch;
  await account.close();
  clearSkills();
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  await fs.rm(root, { recursive: true, force: true });
}
