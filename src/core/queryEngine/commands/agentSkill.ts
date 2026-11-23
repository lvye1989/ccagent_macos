import type { ToolContext } from "../../../tools/Tool.js";
import { getUserSettingsPath } from "../../../utils/paths.js";
import { getSkillState, isAgentSkillsEnabled, setAgentSkillsEnabled, setSkillState } from "../../../utils/agentSkillsEnabled.js";
import { findSkill, getInstalledSkills } from "../../../services/skills/registry.js";
import { deleteSkill } from "../../../services/skills/manage.js";
import { canonicalSkillName } from "../../../services/skills/names.js";
import type { QueryEngineEvent } from "../types.js";

const USAGE = "Usage: /agent-skill [list|open [name]|close [name]|delete <name> [--yes]|status]";
const stateLabel = (name: string) => getSkillState(name) === "open" ? "Open" : "Close";

async function confirmDeletion(name: string, ask?: ToolContext["requestUserQuestion"]): Promise<boolean> {
  if (!ask) return false;
  const question = `删除技能 ${name}？将移入技能回收目录；内置技能不会自动装回。`;
  const response = await ask({ questions: [{ header: "删除技能", question, cancelLabel: "取消删除", options: [
    { label: "取消", description: "保留技能和当前设置。" },
    { label: "确认删除", description: "移除这个技能的入口并保留恢复副本。" },
  ] }] });
  return response?.answers[question] === "确认删除";
}

async function* manageSkillList(
  cwd: string, ask?: ToolContext["requestUserQuestion"],
): AsyncGenerator<QueryEngineEvent, { changed: boolean }> {
  let page = 0;
  let changed = false;
  const inventory = () => getInstalledSkills().sort((a, b) => a.name.localeCompare(b.name));
  const initial = inventory();
  yield { type: "command", kind: "info", message: [
    `已安装技能（${initial.length}） · 总开关 ${isAgentSkillsEnabled() ? "Open" : "Close"}`,
    ...initial.map((skill) => `  ${skill.name} · ${stateLabel(skill.name)} · ${skill.source}${skill.frontmatter.paths?.length ? " · 按路径触发" : ""}${skill.frontmatter.disableModelInvocation ? " · 仅手动调用" : ""}\n    ${skill.description}\n    ${skill.filePath}`),
    !initial.length ? "暂无已安装技能。" : "",
    "/agent-skill open <name> | close <name> | delete <name> [--yes]",
  ].filter(Boolean).join("\n") };
  if (!ask) return { changed };
  for (;;) {
    const skills = inventory();
    if (!skills.length) return { changed };
    const pages = Math.ceil(skills.length / 3);
    page = Math.min(page, pages - 1);
    const choices = skills.slice(page * 3, page * 3 + 3);
    const question = `选择要管理的技能（${page + 1}/${pages}，总开关 ${isAgentSkillsEnabled() ? "Open" : "Close"}）：`;
    const options = choices.map((skill) => ({ label: `${skill.name} · ${stateLabel(skill.name)}`, description: `${skill.source} · ${skill.description}` }));
    if (pages > 1) options.push({ label: "下一页", description: "查看其他已安装技能（循环）。" });
    const response = await ask({ questions: [{ header: "已安装技能", question, options, cancelLabel: "完成管理" }] });
    const answer = response?.answers[question];
    if (answer === "下一页" && pages > 1) { page = (page + 1) % pages; continue; }
    const selected = choices.find((skill) => answer === `${skill.name} · ${stateLabel(skill.name)}` || answer === skill.name);
    if (!selected) return { changed };
    while (findSkill(selected.name)) {
      const detail = `${selected.name} 当前为 ${stateLabel(selected.name)}（${selected.source}）：`;
      const actionResponse = await ask({ questions: [{ header: "技能设置", question: detail, cancelLabel: "返回技能列表", options: [
        { label: "Open", description: "开启这个技能；总开关关闭时仍暂停调用。" },
        { label: "Close", description: "关闭这个技能，保留文件及其他技能状态。" },
        { label: "Delete", description: "删除这个技能，保留可恢复副本。" },
      ] }] });
      const action = actionResponse?.answers[detail];
      if (!["Open", "Close", "Delete"].includes(action || "")) break;
      try {
        if (action === "Delete") {
          if (!await confirmDeletion(selected.name, ask)) continue;
          const backup = await deleteSkill(selected.name, cwd);
          changed = true;
          yield { type: "command", kind: "info", message: `技能 ${selected.name} 已删除。恢复副本：${backup}` };
          break;
        }
        await setSkillState(selected.name, action === "Open" ? "open" : "close");
        changed = true;
        yield { type: "command", kind: "info", message: `${selected.name}: ${action}，已保存并立即生效。${!isAgentSkillsEnabled() ? "总开关为 Close，可用 /agent-skill open 恢复调用。" : ""}` };
      } catch (error) {
        yield { type: "command", kind: "error", message: `技能设置失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }
}

/** Local control command: selecting Open/Close never calls a model or MCP. */
export async function* handleAgentSkillCommand(
  args: string[],
  ask?: ToolContext["requestUserQuestion"],
  cwd: string = process.cwd(),
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  let state: string | undefined = args[0]?.toLowerCase();
  if (state === "list" && args.length === 1) {
    try { yield* manageSkillList(cwd, ask); }
    catch (error) { yield { type: "command", kind: "error", message: `技能管理失败：${error instanceof Error ? error.message : String(error)}` }; }
    return { handled: true };
  }
  if (["open", "close", "delete"].includes(state || "") && args.length >= 2) {
    const name = canonicalSkillName(args[1]);
    if ((state === "delete" && (args.length > 3 || (args[2] && args[2] !== "--yes"))) || (state !== "delete" && args.length !== 2)) {
      yield { type: "command", kind: "error", message: USAGE }; return { handled: true };
    }
    try {
      if (!findSkill(name)) throw new Error(`Skill "${name}" is not installed. Use /agent-skill list.`);
      if (state === "delete") {
        if (args[2] !== "--yes" && !await confirmDeletion(name, ask)) {
          yield { type: "command", kind: ask ? "info" : "error", message: "删除已取消，未更改技能。非交互模式需显式使用 /agent-skill delete <name> --yes。" };
          return { handled: true };
        }
        const backup = await deleteSkill(name, cwd);
        yield { type: "command", kind: "info", message: `技能 ${name} 已删除。恢复副本：${backup}` };
      } else {
        await setSkillState(name, state === "open" ? "open" : "close");
        yield { type: "command", kind: "info", message: `${name}: ${stateLabel(name)}，已保存并立即生效。${!isAgentSkillsEnabled() ? "总开关为 Close。" : ""}` };
      }
    } catch (error) { yield { type: "command", kind: "error", message: `技能设置失败：${error instanceof Error ? error.message : String(error)}` }; }
    return { handled: true };
  }
  if (args.length > 1 || (state && !["open", "close", "status"].includes(state))) {
    yield { type: "command", kind: "error", message: USAGE };
    return { handled: true };
  }
  if (state === "status" || (!state && !ask)) {
    yield { type: "command", kind: "info", message: `Agent Skills: ${isAgentSkillsEnabled() ? "Open" : "Close"}\n/agent-skill open — 开启；/agent-skill close — 关闭。\n/agent-skill list — 列出技能并单独开启、关闭或删除。` };
    return { handled: true };
  }
  const interactive = !state && Boolean(ask);
  let changed = false;
  try {
    do {
      if (interactive && ask) {
        const question = `Agent Skills 当前为 ${isAgentSkillsEnabled() ? "Open" : "Close"}，请选择：`;
        const response = await ask({ questions: [{ header: "Agent Skills", question, cancelLabel: "完成设置", options: [
          { label: "Open", description: "启用技能发现、Skill 工具、技能命令及按路径自动触发。" },
          { label: "Close", description: "停用技能入口，保留已安装技能；不影响 Agent、MCP 和普通工具。" },
          { label: "List", description: "列出已安装技能，单独开启、关闭或删除。" },
        ] }] });
        state = response?.answers[question]?.trim().toLowerCase();
        if (state === "list") {
          const result = yield* manageSkillList(cwd, ask);
          changed ||= result.changed;
          continue;
        }
        if (state !== "open" && state !== "close") {
          yield { type: "command", kind: "info", message: changed
            ? "Agent Skills 设置已完成，已保存的修改立即生效。"
            : "Agent Skills selection cancelled; no settings changed." };
          return { handled: true };
        }
      }
      await setAgentSkillsEnabled(state === "open");
      changed = true;
      yield { type: "command", kind: "info", message: [
        `Agent Skills: ${state === "open" ? "Open — 已开启" : "Close — 已关闭"}，后续技能调用立即生效。`,
        `Saved to: ${getUserSettingsPath()} (agentSkills: ${isAgentSkillsEnabled()})`,
        "不会删除技能、清除已有会话内容或撤销已执行的操作。",
      ].join("\n") };
    } while (interactive);
  } catch (error) {
    yield { type: "command", kind: "error", message: `Could not update Agent Skills: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { handled: true };
}
