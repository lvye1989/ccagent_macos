import type { Tool } from "./Tool.js";
import { TOOL_SEARCH_NAME, type ToolDiscoveryRequest } from "./toolDiscovery.js";

export const toolSearchTool: Tool = {
  name: TOOL_SEARCH_NAME,
  description: "Discover and load deferred tool definitions for this conversation before calling them. Search a task/tool/server (English or Chinese), load exact names, or a built-in group: coding, web, computer, rhino, documents, images, data, knowledge, mail, memory, tasks, planning, skills, agents, workfriend, resources, reference. MCP tools are selected individually; use group mcp:<server> to narrow a search. No arguments lists available groups/servers. Selected definitions become available on the next model call and stay loaded until the conversation is cleared. Discovery does not execute tools or grant permissions.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 500, description: "Task, operation, exact tool name, or connected service." },
      group: { type: "string", maxLength: 200, description: "Built-in group or mcp:<server>; list groups with no arguments." },
      names: { type: "array", items: { type: "string" }, maxItems: 10, description: "Exact tool names to load, instead of query/group." },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum search matches; default 3. A built-in group without a query loads the group." },
    },
    additionalProperties: false,
  },
  decisionPolicy: "local",
  async call(input, context) {
    if (!context.discoverTools) return { content: "Tool discovery is unavailable in this tool scope.", isError: true };
    if ((input.query !== undefined && typeof input.query !== "string") ||
        (input.group !== undefined && typeof input.group !== "string") ||
        (input.names !== undefined && (!Array.isArray(input.names) || input.names.some((name) => typeof name !== "string" || !name.trim()))) ||
        (input.limit !== undefined && typeof input.limit !== "number")) {
      return { content: "Invalid discovery request: query/group must be strings, names a string array, limit an integer from 1 to 10.", isError: true };
    }
    const result = context.discoverTools(input as ToolDiscoveryRequest);
    return { content: JSON.stringify({ type: "tool_discovery", ...result, instruction: "Loaded definitions are available on the next model call. Execute the relevant tool to obtain results; discovery alone performs no task." }), ...(result.error ? { isError: true } : {}) };
  },
  isReadOnly: () => true,
  isEnabled: () => true,
  isConcurrencySafe: () => true,
};
