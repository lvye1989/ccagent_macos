import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getCCAgentPath, getUserSettingsPath } from "../../utils/paths.js";
import { readJsonSettingsFile } from "../../utils/settings.js";
import { setSkillState } from "../../utils/agentSkillsEnabled.js";
import { getProjectSkillsDir, getUserSkillsDir } from "./loadSkillsDir.js";
import { findSkill, getInstalledSkills, removeSkill } from "./registry.js";
import { canonicalSkillName } from "./names.js";

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Move only the selected definition to a recoverable, user-owned archive. */
export async function deleteSkill(name: string, cwd: string): Promise<string> {
  name = canonicalSkillName(name);
  const skill = findSkill(name);
  if (!skill) throw new Error(`Skill "${name}" is not installed.`);
  const settings = await readJsonSettingsFile<unknown>(getUserSettingsPath());
  if (settings.parseError || (settings.raw !== null && (typeof settings.raw !== "object" || Array.isArray(settings.raw)))) throw new Error("Invalid user settings; files were left untouched.");
  if (skill.source === "plugin" && !skill.pluginRoot) throw new Error("Cannot verify the owning plugin directory.");
  const root = await fs.realpath(skill.source === "user" ? getUserSkillsDir()
    : skill.source === "project" ? getProjectSkillsDir(cwd) : skill.pluginRoot || "");
  const file = await fs.realpath(skill.filePath);
  if (!inside(root, file) || file !== skill.filePath || path.basename(file) !== "SKILL.md") throw new Error("Skill path changed or is outside its installation directory; no files were removed.");
  const base = path.dirname(file);
  const shared = getInstalledSkills().some((other) => other.name !== name && inside(base, other.filePath));
  // Plugin roots may contain other components. Root-level/shared definitions
  // lose only SKILL.md; ordinary user/project skill folders move as a unit.
  const target = skill.source !== "plugin" && base !== root && !shared ? base : file;
  const archive = getCCAgentPath("skill-trash", `${Date.now()}-${randomUUID()}`);
  await fs.mkdir(archive, { recursive: true });
  const payload = path.join(archive, path.basename(target));
  let moved = false;
  try {
    await fs.writeFile(path.join(archive, "restore.json"), JSON.stringify({ name, source: skill.source, originalPath: target, backupPath: payload }, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(target, payload);
    moved = true;
    await setSkillState(name, "deleted");
  } catch (error) {
    if (moved) {
      try { await fs.rename(payload, target); }
      catch { throw new Error(`Could not save deletion settings. The skill backup is retained at ${payload}.`); }
    }
    await fs.rm(archive, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  removeSkill(name);
  return archive;
}
