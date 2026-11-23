/** User-wide Skills switch. Installed definitions are retained for reopening. */
import { getUserSettingsPath } from "./paths.js";
import { readJsonSettingsFile, updateUserSettings } from "./settings.js";
import { AUDIO_SKILL_NAME, LEGACY_AUDIO_SKILL_NAME, canonicalSkillName } from "../services/skills/names.js";

let enabled = true;
export type SkillState = "open" | "close" | "deleted";
let skillStates: Record<string, SkillState> = {};
let pendingSkillState: Promise<void> = Promise.resolve();

function parseSkillStates(raw: unknown): Record<string, SkillState> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some((state) => typeof state !== "string" || !["open", "close", "deleted"].includes(state))) {
    throw new Error("skillStates must map skill names to open, close, or deleted; settings were left untouched.");
  }
  const states = { ...raw } as Record<string, SkillState>;
  if (Object.hasOwn(states, LEGACY_AUDIO_SKILL_NAME) && !Object.hasOwn(states, AUDIO_SKILL_NAME)) {
    states[AUDIO_SKILL_NAME] = states[LEGACY_AUDIO_SKILL_NAME];
  }
  delete states[LEGACY_AUDIO_SKILL_NAME];
  return states;
}

export function getSkillState(name: string): SkillState {
  const canonical = canonicalSkillName(name);
  return Object.hasOwn(skillStates, canonical) ? skillStates[canonical] : "open";
}
export function isSkillEnabled(name: string): boolean { return enabled && getSkillState(name) === "open"; }

export function isAgentSkillsEnabled(): boolean {
  return enabled;
}

/** Load only the user preference: project settings cannot reopen Skills. */
export async function bootstrapAgentSkills(): Promise<boolean> {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  if (parseError || (raw !== null && (typeof raw !== "object" || Array.isArray(raw)))) {
    enabled = false;
    throw new Error(parseError ?? "settings.json must contain a JSON object.");
  }
  if (raw?.agentSkills !== undefined && typeof raw.agentSkills !== "boolean") {
    enabled = false;
    throw new Error("agentSkills must be a boolean; Skills remain closed until the setting is fixed.");
  }
  try { skillStates = parseSkillStates(raw?.skillStates); }
  catch (error) { enabled = false; throw error; }
  enabled = raw?.agentSkills !== false;
  return enabled;
}

export async function setAgentSkillsEnabled(next: boolean): Promise<void> {
  const { raw, parseError } = await readJsonSettingsFile<unknown>(getUserSettingsPath());
  if (parseError) throw new Error(`${parseError}\nSettings were left untouched.`);
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("settings.json must contain a JSON object; settings were left untouched.");
  }
  const states = parseSkillStates((raw as Record<string, unknown> | null)?.skillStates);
  await updateUserSettings({ agentSkills: next });
  skillStates = states;
  enabled = next;
}

/** Only user settings can change per-skill preferences, including plugin skills. */
async function persistSkillState(name: string, state: SkillState): Promise<void> {
  if (!name.trim() || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid skill name.");
  if (!["open", "close", "deleted"].includes(state)) throw new Error("Invalid skill state.");
  name = canonicalSkillName(name);
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  if (parseError || (raw !== null && (typeof raw !== "object" || Array.isArray(raw)))) throw new Error("Invalid user settings; settings were left untouched.");
  const next = { ...parseSkillStates(raw?.skillStates), [name]: state };
  await updateUserSettings({ skillStates: next });
  skillStates = next;
}

export function setSkillState(name: string, state: SkillState): Promise<void> {
  const operation = pendingSkillState.then(() => persistSkillState(name, state));
  pendingSkillState = operation.catch(() => {});
  return operation;
}
