import type { ModelProfile, ModelProtocol } from "./profile.js";

export const DEFAULT_QWEN_MODELS = "qwen3.8-max,qwen3.8-flash";
export const DEFAULT_QWEN_OMNI_MODEL = "qwen3.8-omni-flash";
export const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** A model environment variable may contain one model or a comma-separated list. */
export function splitModelNames(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[,，\r\n]+/).map((name) => name.trim()).filter(Boolean))];
}

/** Legacy vision configurations remain valid without treating Max/Flash as Omni. */
export function getQwenOmniModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.QWEN_OMNI_MODEL?.trim();
  if (explicit) return splitModelNames(explicit)[0];
  const legacy = splitModelNames(env.QWEN_MODEL);
  return legacy.length === 1 && /omni|vision|(?:^|[-_/])vl(?:$|[-_/])/i.test(legacy[0])
    ? legacy[0] : undefined;
}

/** Fallback perception profile for main models without image-input support. */
export function qwenOmniEnvironmentProfile(id: string): ModelProfile | null {
  const model = getQwenOmniModel();
  const protocol = process.env.QWEN_PROTOCOL?.trim() || "openai-chat";
  if (!model || !["openai-chat", "openai-responses", "gemini"].includes(protocol)) return null;
  const baseURL = process.env.QWEN_BASE_URL?.trim() || process.env.DASHSCOPE_BASE_URL?.trim();
  const apiKey = process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
  return { id, model, protocol: protocol as ModelProtocol, supportsVision: true, ...(baseURL ? { baseURL } : {}), ...(apiKey ? { apiKey } : {}) };
}

function visionOverride(value: string | undefined): { supportsVision?: boolean } {
  value = value?.trim().toLowerCase();
  if (value === "1" || value === "true") return { supportsVision: true };
  if (value === "0" || value === "false") return { supportsVision: false };
  return {};
}

/** Defaults use only the environment already admitted by loadEnv's trust checks. */
export function environmentModelProfiles(): Record<string, Partial<ModelProfile>> {
  const profiles: Record<string, Partial<ModelProfile>> = {};
  if (process.env.DEEPSEEK_MODEL?.trim()) profiles.deepseek = {
    protocol: (process.env.DEEPSEEK_PROTOCOL || "openai-responses") as ModelProtocol,
    model: process.env.DEEPSEEK_MODEL,
    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
    contextWindow: 1_048_576,
  };
  if (process.env.OLLAMA_MODEL?.trim()) profiles.ollama = {
    protocol: (process.env.OLLAMA_PROTOCOL || "openai-chat") as ModelProtocol,
    model: process.env.OLLAMA_MODEL,
    baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    contextWindow: 65_536,
    ...visionOverride(process.env.OLLAMA_SUPPORTS_VISION),
  };
  const mainModels = splitModelNames(process.env.QWEN_MODEL);
  if (mainModels.length) profiles.qwen = {
    protocol: (process.env.QWEN_PROTOCOL || "openai-chat") as ModelProtocol,
    model: mainModels.join(","),
    baseURL: process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || DEFAULT_DASHSCOPE_BASE_URL,
    apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY,
    ...visionOverride(process.env.QWEN_SUPPORTS_VISION),
  };
  const omni = qwenOmniEnvironmentProfile("qwen-omni");
  if (omni) profiles[omni.id] = { ...omni, maxTokens: 4096 };
  return profiles;
}
