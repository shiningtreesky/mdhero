import { invoke } from "@tauri-apps/api/core";

/**
 * Per-document cache for the reading modes.
 *
 * With a real Markdown file the cache lives next to it:
 *
 *   /docs/技术文档.md  ->  /docs/技术文档.words.json      (词)
 *                     ->  /docs/技术文档.sentences.json  (句)
 *
 * Shape: `{"version":1,"glosses":{"key":["释义"]}}`. Tabs without a disk path
 * (paste / URL / unsaved) fall back to localStorage under the same shape and are
 * never written to disk.
 *
 * Writes go through the Rust `glossary_store` command, which merges one entry
 * under a Mutex and replaces the file atomically, so a write per looked-up
 * word is cheap and two quick lookups cannot clobber each other.
 */

export const GLOSSARY_FILE_SUFFIX = ".words.json";
/** Sentence translations live beside the document too, but in their own file so
 *  long sentence entries never bloat the word cache. */
export const SENTENCE_FILE_SUFFIX = ".sentences.json";

/** `/docs/技术文档.md` → `/docs/技术文档.words.json`. A path without a Markdown
 *  extension just gets the suffix appended. */
export function glossaryCachePath(filePath: string, suffix = GLOSSARY_FILE_SUFFIX): string {
  const withoutMarkdown = filePath.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "");
  return `${withoutMarkdown}${suffix}`;
}

export function isDiskCacheablePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  if (/^(paste|new|url|http|https|data|blob):/i.test(filePath)) return false;
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface GlossCacheDocument {
  version: 1;
  glosses: Record<string, string[]>;
}

/** Tolerates a truncated/damaged file: anything unreadable becomes an empty
 *  cache rather than breaking lookups. */
export function parseGlossCache(text: string | null | undefined): Record<string, string[]> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as { glosses?: unknown } | null;
    const glosses = parsed?.glosses;
    if (!glosses || typeof glosses !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [word, value] of Object.entries(glosses as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
      if (items.length > 0) out[word] = items.slice(0, 2);
    }
    return out;
  } catch {
    return {};
  }
}

function storageKey(key: string): string {
  return `mdhero:glossary:${key}`;
}

export interface GlossCache {
  /** True when entries are written to a `.words.json` next to the document. */
  readonly persisted: boolean;
  /** Resolves once the on-disk entries (if any) are loaded. */
  ready: Promise<void>;
  get(word: string): string[] | undefined;
  /** Fire-and-forget: the in-memory entry is available immediately. */
  set(word: string, glosses: string[]): void;
}

export interface GlossCacheOptions {
  filePath: string | null;
  /** Used for the localStorage key when there is no disk path. */
  memoryKey: string;
  /** Cache file suffix; defaults to the word cache. */
  suffix?: string;
}

export function createGlossCache({ filePath, memoryKey, suffix }: GlossCacheOptions): GlossCache {
  const diskPath = isDiskCacheablePath(filePath) ? glossaryCachePath(filePath!, suffix) : null;
  let entries: Record<string, string[]> = {};
  // Words looked up while the file was still loading must survive the merge.
  const pending: Record<string, string[]> = {};
  let loaded = false;
  let writeChain: Promise<void> = Promise.resolve();

  const key = storageKey(diskPath ? diskPath : memoryKey);

  const ready: Promise<void> = (async () => {
    let stored: Record<string, string[]> = {};
    if (diskPath) {
      try {
        const text = await invoke<string | null>("glossary_read", { path: diskPath });
        stored = parseGlossCache(text);
      } catch {
        stored = {};
      }
    } else {
      try {
        stored = parseGlossCache(globalThis.localStorage?.getItem(key) ?? null);
      } catch {
        stored = {};
      }
    }
    entries = { ...stored, ...pending };
    loaded = true;
  })();

  function writeMemory(): void {
    try {
      const doc: GlossCacheDocument = { version: 1, glosses: entries };
      globalThis.localStorage?.setItem(key, JSON.stringify(doc));
    } catch {
      // Storage may be unavailable; the session still works.
    }
  }

  return {
    persisted: diskPath !== null,
    ready,
    get(word) {
      return entries[word];
    },
    set(word, glosses) {
      const items = glosses.slice(0, 2);
      entries[word] = items;
      if (!loaded) pending[word] = items;
      if (!diskPath) {
        writeMemory();
        return;
      }
      // Chain so two quick lookups serialise on the client too; Rust merges
      // under its own Mutex, so a failed write only loses that one entry.
      writeChain = writeChain
        .then(() => invoke("glossary_store", { path: diskPath, word, glosses: items }))
        .then(() => undefined)
        .catch(() => undefined);
    },
  };
}

/** Keep the cache reachable from tests without dragging in the webview. */
export function createMemoryGlossCache(initial: Record<string, string[]> = {}): GlossCache {
  const entries: Record<string, string[]> = { ...initial };
  return {
    persisted: false,
    ready: Promise.resolve(),
    get: (word) => entries[word],
    set: (word, glosses) => {
      entries[word] = glosses.slice(0, 2);
    },
  };
}
