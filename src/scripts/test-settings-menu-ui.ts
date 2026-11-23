/** Keyboard regression: save repeatedly in one native settings menu. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { Box, render } from "ink";
import { handlePowerSettingCommand } from "../core/queryEngine/commands/powersetting.js";
import { loadMailPowerSettings } from "../config/mailPowerSettings.js";
import { QuestionPrompt } from "../ui/components/QuestionPrompt.js";
import { useQuestionPrompt, type QuestionPromptView } from "../ui/hooks/useQuestionPrompt.js";
import type { UserQuestionRequest, UserQuestionResponse } from "../tools/Tool.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-settings-ui-"));
const oldHome = process.env.CCAGENT_HOME;
const oldFetch = globalThis.fetch;
process.env.CCAGENT_HOME = path.join(root, "user");
globalThis.fetch = async () => { throw new Error("Settings menus must not call a provider"); };
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 36, isTTY: true });
const stderr = new PassThrough();
let output = "";
stdout.on("data", (chunk) => { output += chunk.toString(); });
stderr.on("data", (chunk) => { output += chunk.toString(); });
let request: UserQuestionRequest | null = null;
const pendingQuestion: { resolve: ((answer: UserQuestionResponse | null) => void) | null } = { resolve: null };
let view: QuestionPromptView;
let completed = false;
let questionCount = 0;
let runError: unknown;
const receipts: string[] = [];

function Harness(): React.ReactNode {
  view = useQuestionPrompt({ request, onResolve(answer) {
    const pending = pendingQuestion.resolve;
    pendingQuestion.resolve = null;
    request = null;
    instance.rerender(React.createElement(Harness));
    pending?.(answer);
  } });
  return React.createElement(Box, { flexDirection: "column" }, request
    ? React.createElement(QuestionPrompt, { questions: request.questions, ...view })
    : null);
}

const instance = render(React.createElement(Harness), {
  stdin: stdin as unknown as NodeJS.ReadStream,
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stderr as unknown as NodeJS.WriteStream,
  debug: true, patchConsole: false, exitOnCtrlC: false,
});
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 45));
async function until(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!test()) {
    if (runError) throw runError;
    assert.ok(Date.now() < deadline, "Settings UI did not reach the expected state");
    await pause();
  }
  await pause();
}
async function select(label: string): Promise<void> {
  const index = request!.questions[0].options.findIndex((option) => option.label === label);
  assert.ok(index >= 0, `Missing menu option: ${label}`);
  const before = questionCount;
  stdin.write(String(index + 1));
  await pause();
  stdin.write("\r");
  await until(() => completed || questionCount > before);
}

const run = (async () => {
  try {
    for await (const event of handlePowerSettingCommand([], async (next) => {
      questionCount++;
      request = next;
      return new Promise((resolve) => {
        pendingQuestion.resolve = resolve;
        instance.rerender(React.createElement(Harness));
      });
    })) {
      if (event.type === "command") receipts.push(event.message);
    }
    completed = true;
  } catch (error) { runError = error; }
})();

try {
  await until(() => request !== null);
  await select("QQ 邮箱");
  await select("读");
  await select("开");
  assert.equal(request!.questions[0].header, "权限");
  assert.ok(request!.questions[0].options.find((option) => option.label === "读")?.description?.includes("On"));
  assert.equal((await loadMailPowerSettings()).qq.read, true);

  await select("读");
  await select("关");
  assert.equal(view!.highlight, 0, "The new question must reset a previous Close selection");
  assert.ok(request!.questions[0].options.find((option) => option.label === "读")?.description?.includes("Off"));
  await select("写");
  await select("开");
  assert.equal(completed, false, "Saving must not exit the settings menu");
  const powers = (await loadMailPowerSettings()).qq;
  assert.equal(powers.read, false);
  assert.equal(powers.write, true);
  assert.equal(powers.send, false);

  // Select the actual Done row by keyboard, rather than calling its resolver.
  for (let i = 0; i < request!.questions[0].options.length + 1; i++) {
    stdin.write("\u001b[B");
    await pause();
  }
  stdin.write("\r");
  await until(() => completed);
  await run;
  assert.equal(request, null);
  assert.ok(receipts.some((message) => message.includes("设置已完成")));
  assert.equal(receipts.filter((message) => message.includes("，立即生效。")).length, 3);
  const screen = stripVTControlCharacters(output);
  assert.ok(screen.includes("完成设置") && !screen.includes("Chat about this instead"));
  console.log("[PASS] Native Ink keyboard: three saves in one menu, refreshed states, selection reset, Done, and preserved permissions.");
} finally {
  const pending = pendingQuestion.resolve;
  pendingQuestion.resolve = null;
  pending?.(null);
  await run;
  instance.unmount(); instance.cleanup();
  globalThis.fetch = oldFetch;
  if (oldHome === undefined) delete process.env.CCAGENT_HOME;
  else process.env.CCAGENT_HOME = oldHome;
  await fs.rm(root, { recursive: true, force: true });
}
