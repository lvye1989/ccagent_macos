/**
 * Turn a plain user prompt into multimodal content when it references image/audio
 * files via `@path` tokens. The typed text is preserved verbatim (the
 * `@path` reference stays in it so the model has context); any referenced
 * files are appended as media blocks. Audio is read by the built-in Omni skill.
 *
 * Non-media `@` references (source files, directories) are left untouched —
 * those are handled elsewhere as plain text mentions.
 */

import type { ContentBlock } from "../types/message.js";
import { isImagePath, readImageAsBlock } from "../tools/imageUtils.js";
import { isAudioPath, readAudioAsBlock } from "../tools/audioUtils.js";
import { AUDIO_REF_RE, consumePastedAudio } from "./pastedAudio.js";
import {
  ensureRealPathInsideAllowedRoots,
  resolveWorkspacePath,
} from "../tools/pathUtils.js";
import { IMAGE_REF_RE, consumePastedImage } from "./pastedImages.js";

export interface BuiltUserContent {
  /** Plain string when no images were attached; a block array otherwise. */
  content: string | ContentBlock[];
  /** Successfully attached images (for UI / logging). */
  attached: Array<{ ref: string; bytes: number; mediaType: string; kind?: "image" | "audio" }>;
  /** Human-readable reasons an `@image` reference could not be attached. */
  errors: string[];
}

// Quoting is shared by CLI input and Web attachment references. Do not use
// shell parsing: paths are data, and quoted Windows paths may contain spaces.
const IMAGE_TOKEN_RE = /@(?:"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\[ \t]|[^\s])+))/g;

/** Strip trailing punctuation that commonly follows an inline @reference. */
function cleanToken(raw: string): string {
  return raw.replace(/[)\].,;:!?]+$/, "");
}

export async function buildUserMessageContent(
  prompt: string,
  cwd: string,
): Promise<BuiltUserContent> {
  const candidates = new Set<string>();
  for (const match of prompt.matchAll(IMAGE_TOKEN_RE)) {
    const ref = match[1] !== undefined ? match[1].replace(/\\(["\\])/g, "$1")
      : match[2] !== undefined ? match[2] : cleanToken(match[3] ?? "").replace(/\\ /g, " ");
    if (ref && (isImagePath(ref) || isAudioPath(ref))) candidates.add(ref);
  }

  // Pasted / clipboard images referenced by their `[Image #N]` chip. The bytes
  // live in the in-memory registry (never on the @path / allowed-roots path).
  const pastedIds = new Set<number>();
  for (const match of prompt.matchAll(IMAGE_REF_RE)) {
    pastedIds.add(Number(match[1]));
  }

  const audioIds = new Set([...prompt.matchAll(AUDIO_REF_RE)].map((match) => Number(match[1])));
  if (candidates.size === 0 && pastedIds.size === 0 && audioIds.size === 0) {
    return { content: prompt, attached: [], errors: [] };
  }

  const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
  const attached: BuiltUserContent["attached"] = [];
  const errors: string[] = [];

  for (const id of pastedIds) {
    const img = consumePastedImage(id);
    if (img) {
      blocks.push(img.block);
      attached.push({ ref: `[Image #${id}]`, bytes: img.bytes, mediaType: img.mediaType });
    } else {
      errors.push(`[Image #${id}]: paste is no longer available`);
    }
  }

  for (const id of audioIds) {
    const audio = consumePastedAudio(id);
    if (audio) {
      blocks.push(audio.block);
      attached.push({ ref: `[Audio #${id}]`, bytes: audio.bytes, mediaType: audio.mediaType, kind: "audio" });
    } else errors.push(`[Audio #${id}]: paste is no longer available`);
  }

  for (const ref of candidates) {
    try {
      const abs = resolveWorkspacePath(ref, cwd);
      await ensureRealPathInsideAllowedRoots(abs, cwd);
      const audio = isAudioPath(ref);
      const img = audio ? await readAudioAsBlock(abs) : await readImageAsBlock(abs);
      if (img.ok) {
        blocks.push(img.block);
        attached.push({ ref, bytes: img.bytes, mediaType: img.mediaType, ...(audio ? { kind: "audio" as const } : {}) });
      } else {
        errors.push(`${ref}: ${img.error}`);
      }
    } catch (error: unknown) {
      errors.push(`${ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // No image actually loaded — keep the message a plain string.
  if (attached.length === 0) {
    return { content: prompt, attached, errors };
  }

  return { content: blocks, attached, errors };
}
