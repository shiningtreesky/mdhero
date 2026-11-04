import { invoke } from "@tauri-apps/api/core";
import { pathExists } from "$lib/tauri/files";

/**
 * Whole-document audio cache, written next to the Markdown file:
 *
 *   /docs/readme.md  ->  /docs/readme.mp3        (192 kbps CBR when ffmpeg exists)
 *                        /docs/readme.mp3.json   (content hash + bitrate + duration)
 *
 * A `.part.mp3` file is appended to while chunks are synthesized; it is only
 * renamed to `.mp3` (and paired with the sidecar) once the whole document has
 * been generated, so an interrupted run never leaves a playable-looking cache.
 */

export interface AudioCachePaths {
  audio: string;
  sidecar: string;
  part: string;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Real files can be cached; paste/URL/new tabs have no directory to write to. */
export function isCacheableDocumentPath(path: string): boolean {
  if (!path) return false;
  if (/^(paste|new|url):/i.test(path)) return false;
  if (/^(http|https|data|blob):/i.test(path)) return false;
  return /\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(path);
}

export function audioCachePaths(documentPath: string): AudioCachePaths {
  const audio = documentPath.replace(/\.(md|markdown|mdown|mkd|mdx|txt)$/i, "") + ".mp3";
  return {
    audio,
    sidecar: `${audio}.json`,
    part: `${audio.replace(/\.mp3$/i, "")}.part.mp3`,
  };
}

/**
 * SHA-256 of the Markdown content, used to decide whether a cache file still
 * matches the document. Falls back to a stable FNV-1a digest if a WebView
 * without `crypto.subtle` ever runs the app.
 */
export async function hashDocument(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(content);
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

export interface CacheMeta {
  hash: string;
  bitrate: number;
  duration: number;
  sourceSize: number;
  createdAt: string;
}

export async function hasValidCache(documentPath: string, hash: string): Promise<boolean> {
  if (!isTauriRuntime() || !isCacheableDocumentPath(documentPath)) return false;
  const paths = audioCachePaths(documentPath);
  try {
    return await invoke<boolean>("tts_cache_valid", {
      audioPath: paths.audio,
      sidecarPath: paths.sidecar,
      hash,
    });
  } catch {
    return false;
  }
}

/** Sidecar metadata of a cache file (bitrate, duration, timestamp). */
export async function readCacheMeta(documentPath: string): Promise<CacheMeta | null> {
  if (!isTauriRuntime() || !isCacheableDocumentPath(documentPath)) return null;
  const paths = audioCachePaths(documentPath);
  try {
    const text = await invoke<string | null>("tts_cache_meta", { sidecarPath: paths.sidecar });
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<CacheMeta>;
    return {
      hash: typeof parsed.hash === "string" ? parsed.hash : "",
      bitrate: typeof parsed.bitrate === "number" ? parsed.bitrate : 0,
      duration: typeof parsed.duration === "number" ? parsed.duration : 0,
      sourceSize: typeof parsed.sourceSize === "number" ? parsed.sourceSize : 0,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

/** Raw MP3 bytes of a valid cache; decodes straight into Web Audio. */
export async function readCachedAudio(documentPath: string): Promise<ArrayBuffer> {
  const paths = audioCachePaths(documentPath);
  const data = await invoke<ArrayBuffer | Uint8Array | number[]>("tts_cache_read", {
    audioPath: paths.audio,
  });
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return new Uint8Array(data).buffer;
}

export async function cacheExists(documentPath: string): Promise<boolean> {
  if (!isTauriRuntime() || !isCacheableDocumentPath(documentPath)) return false;
  try {
    return await pathExists(audioCachePaths(documentPath).audio);
  } catch {
    return false;
  }
}

export async function beginCacheWrite(documentPath: string): Promise<void> {
  await invoke("tts_cache_begin", { partPath: audioCachePaths(documentPath).part });
}

export async function appendCacheChunk(documentPath: string, bytes: Uint8Array): Promise<void> {
  await invoke("tts_cache_append", {
    partPath: audioCachePaths(documentPath).part,
    data: toBase64(bytes),
  });
}

export async function finalizeCache(
  documentPath: string,
  hash: string,
  sourceSize: number,
  duration: number,
): Promise<number> {
  const paths = audioCachePaths(documentPath);
  return invoke<number>("tts_cache_finalize", {
    partPath: paths.part,
    audioPath: paths.audio,
    sidecarPath: paths.sidecar,
    hash,
    sourceSize,
    duration,
  });
}

export async function deleteCacheFile(path: string): Promise<void> {
  await invoke("tts_cache_delete", { path });
}

export async function encoderAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("tts_encoder_available");
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Drop the ID3v2 tag Kokoro puts in front of every chunk before appending.
 * Concatenated ID3 headers confuse decoders (ffmpeg reports "Header missing"
 * and loses a few milliseconds at each seam). ID3v1 trailers are dropped too.
 */
export function stripId3Tags(bytes: Uint8Array): Uint8Array {
  let start = 0;
  let end = bytes.length;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
    start = Math.min(bytes.length, 10 + size + footer);
  }
  if (
    end - start >= 128 &&
    bytes[end - 128] === 0x54 &&
    bytes[end - 127] === 0x41 &&
    bytes[end - 126] === 0x47
  ) {
    end -= 128;
  }
  return bytes.subarray(start, end);
}
