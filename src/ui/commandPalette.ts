import type { CommandSuggestion } from "./types.js";
import { getInstalledSkills } from "../services/skills/registry.js";
import { getSkillState } from "../utils/agentSkillsEnabled.js";

interface PaletteEntry {
  token: string;
  description: string;
  /** Complete the input and keep the palette workflow open instead of running. */
  completionOnly?: boolean;
}

const PLUGIN_ACTIONS: PaletteEntry[] = [
  { token: "install", description: "Install a plugin from a marketplace", completionOnly: true },
  { token: "list", description: "List installed plugins and enable state" },
  { token: "marketplace", description: "Manage marketplace sources", completionOnly: true },
  { token: "enable", description: "Enable an installed plugin", completionOnly: true },
  { token: "disable", description: "Disable an installed plugin", completionOnly: true },
  { token: "update", description: "Update an installed plugin", completionOnly: true },
  { token: "uninstall", description: "Uninstall a plugin", completionOnly: true },
  { token: "validate", description: "Validate a plugin or marketplace directory", completionOnly: true },
  { token: "reload", description: "Reload plugins and extension registries" },
];

const MARKETPLACE_ACTIONS: PaletteEntry[] = [
  { token: "add", description: "Add a local directory or Git marketplace", completionOnly: true },
  { token: "list", description: "List registered marketplaces" },
  { token: "update", description: "Update one marketplace, or all when omitted", completionOnly: true },
  { token: "remove", description: "Remove a registered marketplace", completionOnly: true },
];

const SKILL_ACTIONS: PaletteEntry[] = [
  { token: "list", description: "List installed skills and manage each skill" },
  { token: "open", description: "Open all Skills, or append an installed skill name" },
  { token: "close", description: "Close all Skills, or append an installed skill name" },
  { token: "delete", description: "Delete an installed skill with confirmation", completionOnly: true },
  { token: "status", description: "Show the global Skills switch" },
];

function suggestionsFor(
  commandPrefix: string,
  entries: PaletteEntry[],
  partial: string,
  tag: string = "plugin",
): CommandSuggestion[] {
  const query = partial.toLowerCase();
  return entries
    .filter((entry) => entry.token.toLowerCase().startsWith(query))
    .map((entry) => ({
      name: `${commandPrefix} ${entry.token}`,
      description: entry.description,
      tag,
      completionOnly: entry.completionOnly,
    }));
}

/**
 * Return hierarchical slash-command suggestions, or `null` when the ordinary
 * top-level palette should handle the input.
 *
 * Keeping this parser independent from React makes nested command grammar easy
 * to extend and prevents the old "any whitespace closes suggestions" rule
 * from swallowing nested command help.
 */
export function getNestedCommandSuggestions(input: string): CommandSuggestion[] | null {
  if (!input.startsWith("/")) return null;

  const trailingSpace = /\s$/.test(input);
  const trimmed = input.trim();
  const tokens = trimmed.split(/\s+/);
  const root = (tokens[0] ?? "").toLowerCase();

  if (root === "/agent-skill") {
    if (tokens.length === 1) return trailingSpace ? suggestionsFor(root, SKILL_ACTIONS, "", "skill") : null;
    if (tokens.length === 2 && !trailingSpace) return suggestionsFor(root, SKILL_ACTIONS, tokens[1] ?? "", "skill");
    const action = (tokens[1] ?? "").toLowerCase();
    if (["open", "close", "delete"].includes(action) && ((tokens.length === 2 && trailingSpace) || (tokens.length === 3 && !trailingSpace))) {
      const partial = tokens.length === 3 ? tokens[2] ?? "" : "";
      const skills = getInstalledSkills().sort((a, b) => a.name.localeCompare(b.name)).map((skill) => ({
        token: skill.name,
        description: `${getSkillState(skill.name) === "open" ? "Open" : "Close"} · ${skill.source} · ${skill.description}`,
      }));
      return suggestionsFor(`${root} ${action}`, skills, partial, "skill");
    }
    return [];
  }

  if (root === "/marketplace") {
    if (tokens.length === 1) {
      return trailingSpace ? suggestionsFor("/marketplace", MARKETPLACE_ACTIONS, "") : null;
    }
    if (tokens.length === 2 && !trailingSpace) {
      return suggestionsFor("/marketplace", MARKETPLACE_ACTIONS, tokens[1] ?? "");
    }
    return [];
  }

  if (root !== "/plugin" && root !== "/plugins") return null;
  const prefix = root === "/plugins" ? "/plugins" : "/plugin";

  if (tokens.length === 1) {
    return trailingSpace ? suggestionsFor(prefix, PLUGIN_ACTIONS, "") : null;
  }

  if (tokens.length === 2 && !trailingSpace) {
    return suggestionsFor(prefix, PLUGIN_ACTIONS, tokens[1] ?? "");
  }

  const action = (tokens[1] ?? "").toLowerCase();
  if (action === "marketplace" || action === "market") {
    const marketplacePrefix = `${prefix} ${action}`;
    if (tokens.length === 2 && trailingSpace) {
      return suggestionsFor(marketplacePrefix, MARKETPLACE_ACTIONS, "");
    }
    if (tokens.length === 3 && !trailingSpace) {
      return suggestionsFor(marketplacePrefix, MARKETPLACE_ACTIONS, tokens[2] ?? "");
    }
  }

  // The user is now entering a plugin id/path/scope flag. Do not fall back to
  // unrelated top-level commands while they fill the argument.
  return [];
}
