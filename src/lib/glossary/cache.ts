import { invoke } from "@tauri-apps/api/core";
import { cleanPhonetic, type Phonetic } from "$lib/utils/glossary";

/**
 * Per-document cache for the reading modes.
 *
 * With a real Markdown file the cache lives next to it:
 *
 *   /docs/技术文档.md  ->  /docs/技术文档.words.json      (词)
 *                     ->  /docs/技术文档.sentences.json  (句)
 *
 * Shape: `{"version":2,"glosses":{"key":["释义"]},"phonetics":{"key":{"uk":"","us":""}}}`.
 * The `phonetics` map is optional and version-1 files (glosses only) still load.
 * Tabs without a disk path (paste / URL / unsaved) fall back to localStorage
 * under the same shape and are never written to disk.
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

/**
 * One pinned entry. Words store `{ word, occurrence }` (the n-th time that word
 * appears in the document); sentences store `{ key, text, unitIndex, index }`.
 * Stored beside the glosses so reopening a document can restore the pins.
 */
export type StoredPin = Record<string, unknown>;

export interface GlossCacheDocument {
  version: 2;
  glosses: Record<string, string[]>;
  phonetics: Record<string, Phonetic>;
  pins?: StoredPin[];
}

export interface ParsedGlossCache {
  glosses: Record<string, string[]>;
  phonetics: Record<string, Phonetic>;
  pins: StoredPin[];
}

function parsePins(value: unknown): StoredPin[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StoredPin => !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
}

function parseGlosses(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [word, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    const items = entry.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (items.length > 0) out[word] = items.slice(0, 2);
  }
  return out;
}

function parsePhonetics(value: unknown): Record<string, Phonetic> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, Phonetic> = {};
  for (const [word, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const uk = cleanPhonetic(obj.uk);
    const us = cleanPhonetic(obj.us);
    // Older builds wrote an empty pair even when the model was never asked for
    // IPA. Drop those so enabling 音标 refreshes them; a genuinely "unknown"
    // pair is re-queried at most once per session.
    if (!uk && !us) continue;
    out[word] = { uk, us };
  }
  return out;
}

/** Tolerates a truncated/damaged file and version-1 caches that only have
 *  glosses: anything unreadable becomes an empty cache rather than breaking
 *  lookups. */
export function parseGlossCacheDocument(
  text: string | null | undefined,
): ParsedGlossCache {
  if (!text) return { glosses: {}, phonetics: {}, pins: [] };
  try {
    const parsed = JSON.parse(text) as
      | { glosses?: unknown; phonetics?: unknown; pins?: unknown }
      | null;
    if (!parsed || typeof parsed !== "object") {
      return { glosses: {}, phonetics: {}, pins: [] };
    }
    return {
      glosses: parseGlosses(parsed.glosses),
      phonetics: parsePhonetics(parsed.phonetics),
      pins: parsePins(parsed.pins),
    };
  } catch {
    return { glosses: {}, phonetics: {}, pins: [] };
  }
}

/** Gloss-only view kept for callers (and old tests) that do not need IPA. */
export function parseGlossCache(text: string | null | undefined): Record<string, string[]> {
  return parseGlossCacheDocument(text).glosses;
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
  /** IPA cached with the gloss; `undefined` means "never asked for it". */
  getPhonetics(word: string): Phonetic | undefined;
  /** Fire-and-forget: the in-memory entry is available immediately. */
  set(word: string, glosses: string[], phonetic?: Phonetic): void;
  /** Pins restored from the file on load; empty until `ready` resolves. */
  getPins(): StoredPin[];
  /** Replace the whole pinned list in the file. */
  setPins(pins: StoredPin[]): void;
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
  let phonetics: Record<string, Phonetic> = {};
  let pins: StoredPin[] = [];
  // Words looked up while the file was still loading must survive the merge.
  const pending: Record<string, string[]> = {};
  const pendingPhonetics: Record<string, Phonetic> = {};
  let loaded = false;
  let writeChain: Promise<void> = Promise.resolve();

  const key = storageKey(diskPath ? diskPath : memoryKey);

  const ready: Promise<void> = (async () => {
    let stored: ParsedGlossCache = { glosses: {}, phonetics: {}, pins: [] };
    if (diskPath) {
      try {
        const text = await invoke<string | null>("glossary_read", { path: diskPath });
        stored = parseGlossCacheDocument(text);
      } catch {
        stored = { glosses: {}, phonetics: {}, pins: [] };
      }
    } else {
      try {
        stored = parseGlossCacheDocument(globalThis.localStorage?.getItem(key) ?? null);
      } catch {
        stored = { glosses: {}, phonetics: {}, pins: [] };
      }
    }
    entries = { ...stored.glosses, ...pending };
    phonetics = { ...stored.phonetics, ...pendingPhonetics };
    pins = stored.pins;
    loaded = true;
  })();

  function writeMemory(): void {
    try {
      const doc: GlossCacheDocument = { version: 2, glosses: entries, phonetics, pins };
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
    getPhonetics(word) {
      return phonetics[word];
    },
    set(word, glosses, phonetic) {
      const items = glosses.slice(0, 2);
      entries[word] = items;
      if (!loaded) pending[word] = items;

      let cleaned: Phonetic | undefined;
      if (phonetic) {
        cleaned = {
          uk: cleanPhonetic(phonetic.uk),
          us: cleanPhonetic(phonetic.us),
        };
        phonetics[word] = cleaned;
        if (!loaded) pendingPhonetics[word] = cleaned;
      }

      if (!diskPath) {
        writeMemory();
        return;
      }
      // Chain so two quick lookups serialise on the client too; Rust merges
      // under its own Mutex, so a failed write only loses that one entry.
      const args: Record<string, unknown> = {
        path: diskPath,
        word,
        glosses: items,
        // Explicit null keeps the argument present; Rust treats it as None and
        // leaves sentence caches without a phonetics map.
        phoneticUk: cleaned?.uk ?? null,
        phoneticUs: cleaned?.us ?? null,
      };
      writeChain = writeChain
        .then(() => invoke("glossary_store", args))
        .then(() => undefined)
        .catch(() => undefined);
    },
    getPins() {
      return pins;
    },
    setPins(next) {
      pins = next;
      if (!diskPath) {
        writeMemory();
        return;
      }
      // The whole list replaces the file's: unpinning has to be a removal.
      writeChain = writeChain
        .then(() => invoke("glossary_pins_store", { path: diskPath, pins: next }))
        .then(() => undefined)
        .catch(() => undefined);
    },
  };
}

/** Keep the cache reachable from tests without dragging in the webview. */
export function createMemoryGlossCache(
  initial: Record<string, string[]> = {},
  initialPhonetics: Record<string, Phonetic> = {},
  initialPins: StoredPin[] = [],
): GlossCache {
  const entries: Record<string, string[]> = { ...initial };
  const phonetics: Record<string, Phonetic> = { ...initialPhonetics };
  let pins: StoredPin[] = [...initialPins];
  return {
    persisted: false,
    ready: Promise.resolve(),
    get: (word) => entries[word],
    getPhonetics: (word) => phonetics[word],
    set: (word, glosses, phonetic) => {
      entries[word] = glosses.slice(0, 2);
      if (phonetic) {
        phonetics[word] = {
          uk: cleanPhonetic(phonetic.uk),
          us: cleanPhonetic(phonetic.us),
        };
      }
    },
    getPins: () => pins,
    setPins: (next) => {
      pins = next;
    },
  };
}
