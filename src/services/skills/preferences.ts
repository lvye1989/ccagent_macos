/** Shared CLI/Web preferences, including local deletion tombstones. */
import { bootstrapAgentSkills } from "../../utils/agentSkillsEnabled.js";
export { isSkillEnabled, setSkillState } from "../../utils/agentSkillsEnabled.js";
export async function bootstrapSkillStates(): Promise<void> { await bootstrapAgentSkills(); }
