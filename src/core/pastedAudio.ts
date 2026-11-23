import type { AudioBlock } from "../types/message.js";

interface PastedAudio { block: AudioBlock; bytes: number; mediaType: string; filename: string }
const store = new Map<number, PastedAudio>();
let counter = 0;
export function addPastedAudio(audio: PastedAudio): number {
  const id = ++counter;
  store.set(id, audio);
  return id;
}
export function consumePastedAudio(id: number): PastedAudio | undefined {
  const audio = store.get(id);
  store.delete(id);
  return audio;
}
export const audioRefToken = (id: number): string => `[Audio #${id}]`;
export const AUDIO_REF_RE = /\[Audio #(\d+)\]/g;
