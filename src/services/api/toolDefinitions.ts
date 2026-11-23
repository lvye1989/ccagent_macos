import type Anthropic from "@anthropic-ai/sdk";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) =>
    [key, canonicalize((value as Record<string, unknown>)[key])]));
}

/** Equivalent tool catalogues must produce identical bytes after MCP reconnects. */
export function stabilizeToolDefinitions(tools: readonly Anthropic.Tool[]): Anthropic.Tool[] {
  return [...tools]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map((tool) => canonicalize(tool) as Anthropic.Tool);
}
