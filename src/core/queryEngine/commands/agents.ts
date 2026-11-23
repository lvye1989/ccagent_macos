import { findAgent, getAllAgents } from "../../../agents/registry.js";
import { isAgentEnabled, setAgentState } from "../../../agents/preferences.js";
import { getUserSettingsPath } from "../../../utils/paths.js";
import type { ToolContext } from "../../../tools/Tool.js";
import type { QueryEngineEvent } from "../types.js";

type Ask = NonNullable<ToolContext["requestUserQuestion"]>;
const usage = "/agents [list | <name> | open <name> | close <name>]";

async function pickAgent(ask: Ask, cursor: { page: number }): Promise<string | undefined> {
  const all = getAllAgents();
  const pages = Math.ceil(all.length / 3);
  cursor.page = Math.min(cursor.page, Math.max(0, pages - 1));
  while (all.length > 0) {
    const slice = all.slice(cursor.page * 3, cursor.page * 3 + 3);
    const question = `选择 Agent (${cursor.page + 1}/${pages})；Esc 完成设置`;
    const options = slice.map((agent, index) => ({
      label: `${index + 1}. ${agent.agentType}`,
      description: `${isAgentEnabled(agent.agentType) ? "Open" : "Close"} · ${agent.source} · ${agent.whenToUse.slice(0, 90)}`,
    }));
    if (pages > 1) options.push({ label: "Next page", description: "下一页（循环）" });
    const response = await ask({ questions: [{ header: "Agents", question, options, cancelLabel: "完成设置" }] });
    const answer = response?.answers[question];
    if (!answer) return undefined;
    if (answer === "Next page" && pages > 1) { cursor.page = (cursor.page + 1) % pages; continue; }
    const index = options.findIndex((option) => option.label === answer);
    if (index >= 0 && index < slice.length) return slice[index].agentType;
    // Free text must be an exact registered name; never guess which agent to change.
    return all.find((agent) => agent.agentType === answer)?.agentType;
  }
  return undefined;
}

/** Native cards and deterministic writes; no LLM, MCP or agent execution. */
export async function* handleAgentControlsCommand(
  args: string[], ask?: ToolContext["requestUserQuestion"],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const cursor = { page: 0 };
  if (ask && args.length === 1) {
    cursor.page = Math.floor(Math.max(0, getAllAgents().findIndex((agent) => agent.agentType === args[0])) / 3);
  }
  const interactive = Boolean(ask) && args.length <= 1;
  let nextArgs = args;
  for (;;) {
    const result = yield* handleAgentSelection(nextArgs, ask, cursor);
    if (!interactive || result.exitMenu) return { handled: true };
    nextArgs = [];
  }
}

async function* handleAgentSelection(
  args: string[], ask: ToolContext["requestUserQuestion"], cursor: { page: number },
): AsyncGenerator<QueryEngineEvent, { handled: boolean; exitMenu?: boolean }> {
  let action = "select";
  let name: string | undefined;
  try {
    if (args.length === 0 && ask) {
      name = await pickAgent(ask, cursor);
      if (!name) {
        yield { type: "command", kind: "info", message: "Agent 设置已结束，已保存的修改立即生效。" };
        return { handled: true, exitMenu: true };
      }
    } else if (args.length === 2 && ["open", "close"].includes(args[0].toLowerCase())) {
      action = args[0].toLowerCase(); name = args[1];
    } else if (args.length === 1) {
      name = args[0];
    } else {
      throw new Error(`Usage: ${usage}`);
    }
    if (!name || !findAgent(name)) throw new Error(`Unknown agent '${name ?? ""}'. ${usage}`);
    if (action === "select") {
      if (!ask) {
        yield { type: "command", kind: "info", message: `${name}: ${isAgentEnabled(name) ? "Open" : "Close"}\n${usage}` };
        return { handled: true };
      }
      const question = `${name} 当前为 ${isAgentEnabled(name) ? "Open" : "Close"}，请选择：`;
      const response = await ask({ questions: [{ header: "Agent switch", question, cancelLabel: "完成设置", options: [
        { label: "Open", description: "允许模型调用该 Agent；保留原工具权限和安全检查。" },
        { label: "Close", description: "隐藏并阻止该 Agent 的新任务；不删除定义，不强行中断运行中的任务。" },
        { label: "返回", description: "返回 Agent 列表，保留当前设置。" },
      ] }] });
      const answer = response?.answers[question]?.trim().toLowerCase();
      if (answer === "返回") return { handled: true };
      if (answer !== "open" && answer !== "close") {
        yield { type: "command", kind: "info", message: "Agent 设置已结束，已保存的修改立即生效。" };
        return { handled: true, exitMenu: true };
      }
      action = answer;
    }
    // A plugin may have been unloaded while the question card was open.
    if (!findAgent(name)) throw new Error(`Agent '${name}' is no longer loaded; no settings changed.`);
    await setAgentState(name, action === "open" ? "open" : "close");
    yield { type: "command", kind: "info", message: [
      `Agent '${name}': ${isAgentEnabled(name) ? "Open — 已开启" : "Close — 已关闭"}，对新任务立即生效。`,
      `Saved to: ${getUserSettingsPath()} (agentStates)`,
      "保留定义、已有成果和历史记录；已运行的任务不会强制中断。",
      ...(name === "workfriend" ? ["Workfriend 关闭期间暂停专用入口和待发送提醒，重新开启后恢复。"] : []),
    ].join("\n") };
  } catch (error) {
    yield { type: "command", kind: "error", message: `Could not update Agent: ${error instanceof Error ? error.message : String(error)}` };
    return { handled: true, exitMenu: true };
  }
  return { handled: true };
}
