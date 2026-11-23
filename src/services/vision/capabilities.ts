import { createHash } from "node:crypto";
import type { ModelProfile } from "../api/providers/profile.js";

const ollamaCapabilities = new Map<string, { value: boolean | undefined; expires: number }>();

function isOllama(profile: ModelProfile): boolean {
  if (!profile.baseURL || profile.protocol !== "openai-chat") return false;
  try {
    return profile.id === "ollama" || new URL(profile.baseURL).port === "11434" ||
      profile.baseURL.replace(/\/+$/, "") === process.env.OLLAMA_BASE_URL?.replace(/\/+$/, "");
  } catch { return false; }
}

/** The server's deployed model may omit the vision encoder of its cloud sibling. */
async function ollamaSupportsImages(profile: ModelProfile, signal?: AbortSignal): Promise<boolean | undefined> {
  const key = createHash("sha256").update(JSON.stringify([profile.baseURL, profile.model, profile.apiKey, profile.headers])).digest("hex");
  const cached = ollamaCapabilities.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const remember = (value: boolean | undefined): boolean | undefined => {
    if (ollamaCapabilities.size >= 64) ollamaCapabilities.delete(ollamaCapabilities.keys().next().value!);
    ollamaCapabilities.set(key, { value, expires: Date.now() + (value === undefined ? 15_000 : 5 * 60_000) });
    return value;
  };
  try {
    const base = profile.baseURL!.replace(/\/+$/, "").replace(/\/v1$/, "");
    const response = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}), ...profile.headers },
      body: JSON.stringify({ model: profile.model }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000),
    });
    if (!response.ok) return remember(undefined);
    const body = await response.json() as { capabilities?: unknown };
    if (!Array.isArray(body.capabilities)) return remember(undefined);
    return remember(body.capabilities.includes("vision"));
  } catch (error) {
    if (signal?.aborted) throw error;
    return remember(undefined);
  }
}

/** Explicit settings, deployed Ollama metadata, then known image-capable families. */
export async function modelSupportsImages(profile: ModelProfile, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (profile.supportsVision !== undefined) return profile.supportsVision;
  const local = isOllama(profile);
  if (local) {
    return (await ollamaSupportsImages(profile, signal)) ?? false;
  }
  const name = profile.model.toLowerCase().split("/").at(-1)!;
  if (/(?:^|[-_])(?:vl|vision|omni)(?:[-_:]|$)/.test(name) || /^(?:llava|bakllava)/.test(name)) return true;
  // Cloud Qwen3.5+ families accept images; qwen-plus / older text names do not.
  // https://help.aliyun.com/en/model-studio/web-search#supported-models
  if (/^(?:qwen3\.(?:5|6|7)-(?:plus|flash)|qwen3\.8-(?:max|flash))(?:-|$)/.test(name)) return true;
  if (/^(?:claude-(?:instant|[12])(?:[.-]|$)|o1-(?:mini|preview)(?:-|$)|o3-mini(?:-|$))/.test(name)) return false;
  if (profile.protocol === "gemini" || /^claude(?:-|$)/.test(name)) return true;
  if (/^(?:gpt-(?:4o|4\.1|5)(?:[-.]|$)|o[134](?:-|$))/.test(name)) return true;
  return false;
}
