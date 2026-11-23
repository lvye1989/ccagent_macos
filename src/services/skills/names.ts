/** Canonical built-in names; aliases remain valid for existing commands/settings. */
export const AUDIO_SKILL_NAME = "read-audio";
export const LEGACY_AUDIO_SKILL_NAME = "read_audio.skill";

export function canonicalSkillName(name: string): string {
  return name === LEGACY_AUDIO_SKILL_NAME ? AUDIO_SKILL_NAME : name;
}
