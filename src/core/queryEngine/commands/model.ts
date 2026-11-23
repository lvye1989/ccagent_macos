import type { ToolContext } from "../../../tools/Tool.js";
import { loadProfiles, resolveProfile, type ModelProfile } from "../../../services/api/providers/profile.js";
import { getUserSettingsPath } from "../../../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../../../utils/settings.js";

export interface ModelSelection { handle: string; save: boolean }

/** Save a user-wide default without replacing credentials or unrelated preferences. */
export async function saveDefaultModel(model: string, cwd: string): Promise<{ handle: string; profile: ModelProfile; effectiveDefault: string; path: string }> {
  const handle = model.trim();
  if (!handle || /\s/.test(handle) || ["default", "list", "save"].includes(handle)) throw new Error("请指定有效模型：/model save <模型名称或 Profile ID>");
  const profile = await resolveProfile(handle, cwd);
  const file = getUserSettingsPath();
  const { raw, parseError } = await readJsonSettingsFile<unknown>(file);
  if (parseError || (raw !== null && (typeof raw !== "object" || Array.isArray(raw)))) {
    throw new Error("用户 settings.json 格式错误，已保留原文件；请修复后重试。");
  }
  // `model` was the legacy user default and otherwise takes precedence at
  // startup. Explicit command-line/project overrides keep their own scopes.
  await updateUserSettings({ defaultModel: profile.id, ...(raw && Object.hasOwn(raw, "model") ? { model: undefined } : {}) });
  const { defaultModel } = await loadProfiles(cwd);
  return { handle: profile.id, profile, effectiveDefault: defaultModel || profile.id, path: file };
}

/** Local selector; the caller reloads profiles and current state after each save. */
export async function chooseModel(
  ask: NonNullable<ToolContext["requestUserQuestion"]>,
  profiles: ModelProfile[], active: string, defaultModel: string, cursor: { page: number },
): Promise<ModelSelection | null> {
  const choices = profiles.map((profile) => ({
    id: profile.id,
    label: `${profile.model} · ${profile.id}`,
    description: [
      profile.id === active || profile.model === active ? "当前模型" : "",
      profile.id === defaultModel || profile.model === defaultModel ? "默认模型" : "",
      profile.id === "qwen-omni" ? "Omni 多模态 / 音频读取" : "",
      profile.protocol,
    ].filter(Boolean).join(" · "),
  }));
  choices.push({ id: "default", label: "恢复默认模型", description: defaultModel });
  const pages = Math.ceil(choices.length / 3);
  cursor.page = Math.min(cursor.page, pages - 1);
  for (;;) {
    const slice = choices.slice(cursor.page * 3, cursor.page * 3 + 3);
    const options = slice.map(({ label, description }) => ({ label, description }));
    if (pages > 1) options.push({ label: "下一页", description: "查看其他模型（循环）" });
    const question = `选择模型（${cursor.page + 1}/${pages}，当前 ${active}，默认 ${defaultModel}）`;
    const response = await ask({ questions: [{ header: "模型", question, options, cancelLabel: "完成选择" }] });
    const answer = response?.answers[question]?.trim();
    if (answer === "下一页" && pages > 1) { cursor.page = (cursor.page + 1) % pages; continue; }
    const selected = slice.find((choice) => choice.label === answer || choice.id === answer);
    if (!selected) return null;
    if (selected.id === "default") return { handle: "default", save: false };
    const saveQuestion = `使用 ${selected.label}：`;
    const saveResponse = await ask({ questions: [{ header: "模型设置", question: saveQuestion, cancelLabel: "返回模型列表", options: [
      { label: "仅当前会话", description: "立即切换，保留已保存的默认模型。" },
      { label: "保存为默认", description: "立即切换并保存为用户默认，后续启动继续使用。" },
    ] }] });
    const action = saveResponse?.answers[saveQuestion]?.trim();
    if (action === "仅当前会话" || action === "保存为默认") return { handle: selected.id, save: action === "保存为默认" };
    // Cancelling the save decision returns to the list without changing state.
  }
}
