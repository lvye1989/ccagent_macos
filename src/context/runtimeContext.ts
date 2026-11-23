import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

export const RUNTIME_CONTEXT_PREFIX = "[runtime-context]\n";

export interface RuntimeEnvironmentContext {
  cwd: string;
  toolTempRoot: string;
  date: string;
  timeZone?: string;
  os: string;
  gitBranch?: string;
  gitStatus?: string;
  gitRecentCommit?: string;
}

/** Keep changing workspace state out of the system/tool prefix. */
export function formatRuntimeState(context: RuntimeEnvironmentContext): string {
  const lines = [
    `- Current date: ${context.date}${context.timeZone ? ` (${context.timeZone})` : ""}`,
  ];
  if (context.gitBranch) lines.push(`- Git branch: ${context.gitBranch}`);
  if (context.gitStatus) lines.push(`- Git status snapshot:\n${context.gitStatus}`);
  if (context.gitRecentCommit) lines.push(`- Recent commit: ${context.gitRecentCommit}`);
  return lines.join("\n");
}

/**
 * Append a fresh snapshot only when state changed, or after compaction removed
 * the old one. Inspect history rather than a process cache so resume/rewind and
 * /clear behave the same as a new session, without rewriting an existing prefix.
 */
export function appendRuntimeContext(
  messages: MessageParam[],
  context: RuntimeEnvironmentContext,
): MessageParam[] {
  const content = RUNTIME_CONTEXT_PREFIX +
    "Workspace state for this turn; this snapshot supersedes earlier workspace snapshots.\n" +
    formatRuntimeState(context);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (isRuntimeContextMessage(message)) {
      if (message.content === content) return messages;
      break;
    }
  }
  return [...messages, { role: "user", content }];
}

export function isRuntimeContextMessage(message: MessageParam): boolean {
  return message.role === "user" && typeof message.content === "string" &&
    message.content.startsWith(RUNTIME_CONTEXT_PREFIX);
}
