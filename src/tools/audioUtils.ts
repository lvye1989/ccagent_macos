import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AudioBlock } from "../types/message.js";

const DIRECT_FORMATS: Record<string, { format: AudioBlock["source"]["format"]; mediaType: string }> = {
  ".wav": { format: "wav", mediaType: "audio/wav" },
  ".mp3": { format: "mp3", mediaType: "audio/mpeg" },
  ".amr": { format: "amr", mediaType: "audio/amr" },
  ".aac": { format: "aac", mediaType: "audio/aac" },
  ".3gp": { format: "3gp", mediaType: "audio/3gpp" },
  ".3gpp": { format: "3gpp", mediaType: "audio/3gpp" },
};
const CONVERT_FORMATS = new Set([".m4a", ".flac", ".ogg", ".opus", ".aif", ".aiff"]);
// DashScope requires the encoded audio to be smaller than 10 MB.
export const MAX_AUDIO_BYTES = 7 * 1024 * 1024;
const run = promisify(execFile);

export function isAudioPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return Object.hasOwn(DIRECT_FORMATS, extension) || CONVERT_FORMATS.has(extension);
}

export function parsePastedAudioPath(raw: string): string | null {
  let value = raw.trim();
  if (!value || value.includes("\n")) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (value.startsWith("file://")) {
    try { value = decodeURIComponent(value.slice(7)); } catch { return null; }
  }
  value = value.replace(/\\ /g, " ");
  return isAudioPath(value) && existsSync(value) ? value : null;
}

export type ReadAudioResult =
  | { ok: true; block: AudioBlock; bytes: number; mediaType: string }
  | { ok: false; error: string };

/** The caller owns path authorization; explicit paste follows the image-upload path. */
export async function readAudioAsBlock(filePath: string, signal?: AbortSignal): Promise<ReadAudioResult> {
  let temp: string | undefined;
  try {
    if (!isAudioPath(filePath)) return { ok: false, error: "Unsupported audio format." };
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: "Audio path must be a regular file." };
    if (!stat.size) return { ok: false, error: "Audio file is empty." };
    if (stat.size > MAX_AUDIO_BYTES) return { ok: false, error: "Audio exceeds the 7 MiB local upload limit; split or compress the recording." };
    let input = filePath;
    let format = DIRECT_FORMATS[path.extname(filePath).toLowerCase()];
    if (!format) {
      temp = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-audio-"));
      input = path.join(temp, "audio.wav");
      try {
        await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", filePath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", input], { timeout: 30_000, signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.platform !== "darwin") throw error;
        await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", filePath, input], { timeout: 30_000, signal });
      }
      format = DIRECT_FORMATS[".wav"];
    }
    const converted = await fs.stat(input);
    if (converted.size > MAX_AUDIO_BYTES) return { ok: false, error: "Converted audio exceeds 7 MiB; split it or provide a smaller MP3/WAV file." };
    const bytes = await fs.readFile(input, { signal });
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) return { ok: false, error: "Audio is empty or exceeds the upload limit." };
    return { ok: true, bytes: bytes.length, mediaType: format.mediaType,
      block: { type: "audio", filename: path.basename(filePath), source: { type: "base64", format: format.format, media_type: format.mediaType, data: bytes.toString("base64") } } };
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? "Audio file or converter not found; provide WAV/MP3 or install ffmpeg for conversion."
      : "Cannot read/decode audio; check the file and use WAV/MP3, or install ffmpeg for other formats." };
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}
