import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { parseMcpToolName } from "../services/mcp/mcpStringUtils.js";

export const TOOL_SEARCH_NAME = "ToolSearch";
export const CORE_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "Bash", "AskUserQuestion", TOOL_SEARCH_NAME]);

const GROUPS = {
  coding: { description: "Files and shell / 文件编辑、代码、终端", names: ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "PowerShell"], aliases: ["代码", "文件", "编辑", "编程", "终端", "shell", "file", "code"] },
  web: { description: "Web search and pages / 网页搜索", names: ["BrowserSearch", "WebSearch", "WebFetch"], aliases: ["网页", "网站", "上网", "浏览器搜索", "web", "browser", "internet"] },
  computer: { description: "Desktop and browser control / 电脑操作", names: ["ComputerObserve", "ComputerActionGroup", "ComputerAction", "ComputerNavigate"], aliases: ["电脑", "桌面", "截图", "点击", "computer", "desktop", "screenshot"] },
  rhino: { description: "Rhino / Grasshopper / 三维建模", names: ["RhinoObserve", "RhinoInspect", "RhinoAction", "RhinoSequence"], aliases: ["rhino", "grasshopper", "犀牛", "建模", "三维", "3d"] },
  documents: { description: "PDF and Word conversion / 文档转换", names: ["MarkdownToPdf", "WordToPdf", "PdfToWord", "PdfToMarkdown"], aliases: ["pdf", "word", "markdown", "转换", "文档转换"] },
  images: { description: "Image reading and generation / 读图与生图", names: ["ReadImage", "GenerateImage"], aliases: ["图片", "图像", "读图", "识图", "生图", "image", "vision", "picture"] },
  data: { description: "Local data analysis / 本地数据分析", names: ["AnalyzeData"], aliases: ["数据", "分析", "统计", "表格", "data", "analysis", "spreadsheet", "excel", "csv"] },
  knowledge: { description: "Connected knowledge bases / 外接知识库", names: ["KnowledgeSearch"], aliases: ["知识库", "知识检索", "knowledge", "rag"] },
  mail: { description: "Local email accounts / 本地邮箱", names: ["Mail"], aliases: ["邮箱", "邮件", "mail", "qq", "163"] },
  memory: { description: "Persistent project memory / 项目记忆", names: ["MemoryWrite"], aliases: ["记忆", "记住", "memory", "remember"] },
  tasks: { description: "Task tracking / 任务管理", names: ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList"], aliases: ["任务", "待办", "todo", "task"] },
  planning: { description: "Planning mode / 计划模式", names: ["EnterPlanMode", "ExitPlanMode"], aliases: ["计划", "规划", "plan"] },
  skills: { description: "Installed skills / 技能", names: ["Skill"], aliases: ["技能", "skill"] },
  agents: { description: "Agents and teams / 代理与团队", names: ["Agent", "AgentTeamMode", "TeamCreate", "TeamDelete", "SendMessage"], aliases: ["代理", "团队", "子代理", "agent", "team", "delegate"] },
  workfriend: { description: "Workfriend workflows / 工作伙伴", names: ["WorkfriendAssess", "WorkfriendSchedule", "WorkfriendDeliver"], aliases: ["workfriend", "工作伙伴"] },
  resources: { description: "MCP resources / MCP 资源", names: ["ListMcpResources", "ReadMcpResource"], aliases: ["资源", "resource"] },
  reference: { description: "Classic words / 古典语录", names: ["classic_words"], aliases: ["语录", "名言", "classic", "quote"] },
} satisfies Record<string, { description: string; names: string[]; aliases: string[] }>;

const SERVER_ALIASES: Record<string, string[]> = {
  "google-gmail": ["gmail", "谷歌邮件", "邮件", "邮箱", "email"],
  "google-drive": ["drive", "网盘", "云盘", "谷歌文件"],
  "google-docs": ["docs", "谷歌文档", "文档"],
  "google-sheets": ["sheets", "表格", "电子表格", "spreadsheet"],
  "google-slides": ["slides", "幻灯片", "演示", "ppt", "presentation"],
  "google-calendar": ["calendar", "日历", "日程", "会议"],
  "google-chat": ["chat", "聊天", "群聊"],
  "google-people": ["people", "contacts", "联系人", "通讯录"],
};
const OPERATIONS = [
  { names: ["search", "find", "query"], aliases: ["搜索", "查找", "查询", "search", "find"] },
  { names: ["list"], aliases: ["列出", "列表", "list"] },
  { names: ["get", "read", "fetch"], aliases: ["读取", "查看", "获取", "read", "get"] },
  { names: ["create", "insert", "add"], aliases: ["创建", "新建", "添加", "create", "add"] },
  { names: ["update", "edit", "modify"], aliases: ["修改", "更新", "编辑", "update", "edit"] },
  { names: ["delete", "remove", "trash"], aliases: ["删除", "移除", "delete", "remove"] },
  { names: ["send"], aliases: ["发送", "发信", "send"] },
];

export interface ToolDiscoveryRequest {
  query?: string;
  group?: string;
  names?: string[];
  limit?: number;
}

export interface ToolDiscoveryResult {
  loaded: string[];
  matches: Array<{ name: string; group: string; description: string }>;
  groups?: Array<{ id: string; description: string; tools: number }>;
  remaining?: number;
  error?: string;
}

function groupFor(name: string): string {
  const mcp = parseMcpToolName(name);
  if (mcp) return `mcp:${mcp.serverName}`;
  return Object.entries(GROUPS).find(([, group]) => group.names.some((n) => n === name))?.[0] ?? "other";
}

function score(tool: Anthropic.Tool, query: string): number {
  const name = tool.name.toLowerCase();
  if (name === query) return 1000;
  const groupId = groupFor(tool.name);
  const group = Object.hasOwn(GROUPS, groupId) ? GROUPS[groupId as keyof typeof GROUPS] : undefined;
  const server = groupId.slice(4);
  const aliases = group?.aliases ?? (Object.hasOwn(SERVER_ALIASES, server) ? SERVER_ALIASES[server]! : [groupId]);
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const description = (tool.description ?? "").toLowerCase();
  let value = aliases.some((alias) => query.includes(alias)) ? 20 : 0;
  for (const term of terms) {
    if (name.includes(term)) value += 12;
    if (description.includes(term)) value += 1;
  }
  // An operation alone must not match unrelated services; it only refines a
  // domain/name match, including Chinese natural-language queries.
  if (value > 0) {
    for (const operation of OPERATIONS) {
      if (operation.aliases.some((alias) => query.includes(alias)) && operation.names.some((verb) => name.includes(verb))) value += 15;
    }
    if (!OPERATIONS.some((operation) => operation.aliases.some((alias) => query.includes(alias)))) {
      if (/(?:^|__|_)(?:search|list|get|read)(?:_|$)/.test(name)) value += 3;
    }
  }
  return value;
}

/** Per-conversation selection. The getter is always scoped to this agent/mode. */
export class ToolDiscovery {
  private readonly selected = new Set<string>();
  constructor(private readonly getAvailable: () => Anthropic.Tool[]) {}

  getVisibleTools(available = this.getAvailable()): Anthropic.Tool[] {
    // Narrow scopes without discovery must retain their explicitly allowed tools.
    if (!available.some((tool) => tool.name === TOOL_SEARCH_NAME)) return available;
    return available.filter((tool) => CORE_TOOL_NAMES.has(tool.name) || this.selected.has(tool.name));
  }

  reset(messages: readonly MessageParam[] = []): void {
    this.selected.clear();
    this.restore(messages);
  }

  restore(messages: readonly MessageParam[], tools = this.getAvailable()): void {
    const available = new Set(tools.map((tool) => tool.name));
    const calls = new Map<string, string>();
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (message.role === "assistant" && block.type === "tool_use") calls.set(block.id, block.name);
        if (message.role !== "user" || block.type !== "tool_result" || block.is_error) continue;
        const name = calls.get(block.tool_use_id);
        if (name && available.has(name)) this.selected.add(name);
        if (name !== TOOL_SEARCH_NAME || typeof block.content !== "string") continue;
        try {
          const value = JSON.parse(block.content);
          if (value?.type !== "tool_discovery" || !Array.isArray(value.loaded)) continue;
          for (const name of value.loaded) if (typeof name === "string" && available.has(name)) this.selected.add(name);
        } catch { /* Ordinary tool results are not discovery records. */ }
      }
    }
  }

  discover(request: ToolDiscoveryRequest): ToolDiscoveryResult {
    const available = this.getAvailable();
    const byName = new Map(available.map((tool) => [tool.name, tool]));
    const empty = (error: string): ToolDiscoveryResult => ({ loaded: [], matches: [], error });
    const query = request.query?.normalize("NFKC").trim().toLowerCase() ?? "";
    const group = request.group?.trim().replace(/^mcp__/, "mcp:") ?? "";
    const names = request.names ?? [];
    if (query.length > 500 || group.length > 200 || names.length > 10) return empty("Use a query under 500 characters or at most 10 exact tool names.");
    if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 10)) return empty("limit must be an integer between 1 and 10.");
    if (names.length && (query || group)) return empty("Use exact names or a query/group, not both.");

    if (!query && !group && !names.length) {
      const counts = new Map<string, number>();
      for (const tool of available) {
        if (tool.name === TOOL_SEARCH_NAME) continue;
        const id = groupFor(tool.name);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return { loaded: [], matches: [], groups: [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, tools]) => ({ id, tools, description: Object.hasOwn(GROUPS, id) ? GROUPS[id as keyof typeof GROUPS].description : id.startsWith("mcp:") ? `Connected MCP tools: ${id.slice(4)}` : "Other registered tools" })) };
    }

    let candidates: Anthropic.Tool[];
    if (names.length) {
      const missing = names.filter((name) => !byName.has(name));
      if (missing.length) return empty(`Tools unavailable in this scope or closed: ${missing.join(", ")}`);
      candidates = [...new Set(names)].map((name) => byName.get(name)!);
    } else {
      const filtered = group ? available.filter((tool) => groupFor(tool.name) === group || groupFor(tool.name) === `mcp:${group}`) : available;
      if (group && !filtered.length) return empty(`No available tools in group "${group}". Call ToolSearch with no arguments to list groups.`);
      candidates = filtered.filter((tool) => tool.name !== TOOL_SEARCH_NAME)
        .map((tool) => ({ tool, rank: query ? score(tool, query) : 1 }))
        .filter(({ rank }) => rank > 0)
        .sort((a, b) => b.rank - a.rank || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
        .map(({ tool }) => tool);
    }
    // Loading a small built-in group is convenient; MCP services stay bounded
    // to individual matches rather than loading every schema on that server.
    const limit = names.length ? names.length : request.limit ?? (group && !query && Object.hasOwn(GROUPS, group) ? 10 : 3);
    const chosen = candidates.slice(0, limit);
    for (const tool of chosen) this.selected.add(tool.name);
    return {
      loaded: chosen.map((tool) => tool.name),
      matches: chosen.map((tool) => ({ name: tool.name, group: groupFor(tool.name), description: (tool.description ?? "").slice(0, 180) })),
      remaining: Math.max(0, candidates.length - chosen.length),
      ...(!chosen.length ? { error: "No matching enabled tools. Try an English task/tool name, a group, or list groups with no arguments." } : {}),
    };
  }
}
