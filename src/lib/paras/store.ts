import { invoke } from "@tauri-apps/api/core";
import { get, writable, type Writable } from "svelte/store";
import { translate } from "$lib/i18n";
import { showToast } from "$lib/stores/toast";
import { isDiskCacheablePath } from "$lib/glossary/cache";

/**
 * Per-document paragraph translations for the reading ("段") mode.
 *
 * With a real Markdown file the cache lives next to it:
 *
 *   /docs/技术文档.md  ->  /docs/技术文档.paras.json
 *
 * Shape: `{"version":1,"items":[{"index":3,"hash":"…","text":"译文",
 * "status":"translated","updatedAt":123}]}`. Tabs without a disk path (paste /
 * URL / unsaved) keep the same shape in localStorage and are never written to
 * disk.
 *
 * Drafts (text typed but not yet confirmed) always live in localStorage under
 * their own key: they must survive a tab switch, a close, a re-render or
 * leaving the mode, and they must not pollute the confirmed `.paras.json`.
 *
 * `parasDocuments` is the published paragraph list of every article that
 * currently has the mode running. The toolbar reads it for progress and 对比提交
 * reads it for its request; the action rewrites it whenever the document
 * changes.
 */

export const PARAS_FILE_SUFFIX = ".paras.json";

export type ParaStatus = "translated" | "skipped";

export interface ParaItem {
  index: number;
  hash: string;
  text: string;
  status: ParaStatus;
  updatedAt: number;
}

export interface ParasState {
  items: Record<number, ParaItem>;
  drafts: Record<number, string>;
}

/** `/docs/技术文档.md` → `/docs/技术文档.paras.json`. A path without a Markdown
 *  extension just gets the suffix appended. */
export function parasCachePath(filePath: string): string {
  const withoutMarkdown = filePath.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "");
  return `${withoutMarkdown}${PARAS_FILE_SUFFIX}`;
}

/** Tolerates a truncated or damaged file: anything unreadable becomes an empty
 *  set of items rather than breaking the mode. Later duplicates win. */
export function parseParasDocument(text: string | null | undefined): ParaItem[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const rawItems = Array.isArray(parsed)
      ? parsed
      : (parsed as { items?: unknown } | null)?.items;
    if (!Array.isArray(rawItems)) return [];
    const out: ParaItem[] = [];
    const seen = new Map<number, ParaItem>();
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const value = raw as Record<string, unknown>;
      const index = value.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;
      const status = value.status === "skipped" ? "skipped" : "translated";
      const item: ParaItem = {
        index,
        hash: typeof value.hash === "string" ? value.hash : "",
        text: typeof value.text === "string" ? value.text : "",
        status,
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
      };
      seen.set(index, item);
    }
    for (const item of seen.values()) out.push(item);
    return out.sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

export function parseParasDrafts(text: string | null | undefined): Record<number, string> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as { drafts?: unknown } | null;
    const drafts = parsed?.drafts;
    if (!drafts || typeof drafts !== "object") return {};
    const out: Record<number, string> = {};
    for (const [key, value] of Object.entries(drafts as Record<string, unknown>)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) continue;
      if (typeof value === "string" && value.length > 0) out[index] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function parasItemsToDocument(items: Iterable<ParaItem>): string {
  const sorted = Array.from(items).sort((a, b) => a.index - b.index);
  return JSON.stringify({ version: 1, items: sorted });
}

function toRecord(items: ParaItem[]): Record<number, ParaItem> {
  const out: Record<number, ParaItem> = {};
  for (const item of items) out[item.index] = item;
  return out;
}

function omitDraft(drafts: Record<number, string>, index: number): Record<number, string> {
  if (!(index in drafts)) return drafts;
  const next = { ...drafts };
  delete next[index];
  return next;
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage may be unavailable; the session still works in memory.
  }
}

let memoryHintShown = false;

export interface ParasSession {
  /** True when items are written to a `.paras.json` next to the document. */
  readonly persisted: boolean;
  /** Resolves once the on-disk items and drafts are loaded. */
  readonly ready: Promise<void>;
  readonly state: Writable<ParasState>;
  getItem(index: number): ParaItem | undefined;
  getDraft(index: number): string | undefined;
  setItem(item: ParaItem): void;
  setDraft(index: number, text: string): void;
  clearDraft(index: number): void;
}

export interface ParasSessionOptions {
  filePath: string | null;
  /** Used for the localStorage keys when there is no disk path. */
  memoryKey: string;
}

export function createParasSession({ filePath, memoryKey }: ParasSessionOptions): ParasSession {
  const diskPath = isDiskCacheablePath(filePath) ? parasCachePath(filePath!) : null;
  const key = diskPath ?? memoryKey;
  const itemsKey = `mdhero:paras:${key}`;
  const draftsKey = `mdhero:paras-draft:${key}`;

  if (!diskPath && !memoryHintShown) {
    memoryHintShown = true;
    showToast(translate("paras.memoryOnly"));
  }

  const state = writable<ParasState>({ items: {}, drafts: {} });
  let loaded = false;
  // Saved while the file was still loading: these win over the stored copy.
  const pendingItems: Record<number, ParaItem> = {};
  const pendingDrafts: Record<number, string> = {};
  let writeChain: Promise<void> = Promise.resolve();

  function writeDrafts(): void {
    const drafts = get(state).drafts;
    const trimmed: Record<string, string> = {};
    for (const [index, text] of Object.entries(drafts)) {
      if (text.length > 0) trimmed[index] = text;
    }
    if (Object.keys(trimmed).length === 0) {
      try {
        globalThis.localStorage?.removeItem(draftsKey);
      } catch {
        // Storage may be unavailable; nothing to persist either way.
      }
      return;
    }
    writeStorage(draftsKey, JSON.stringify({ version: 1, drafts: trimmed }));
  }

  const ready: Promise<void> = (async () => {
    let items: ParaItem[] = [];
    if (diskPath) {
      try {
        items = parseParasDocument(await invoke<string | null>("paras_read", { path: diskPath }));
      } catch {
        items = [];
      }
    } else {
      items = parseParasDocument(readStorage(itemsKey));
    }
    const drafts = parseParasDrafts(readStorage(draftsKey));
    state.set({
      items: { ...toRecord(items), ...pendingItems },
      drafts: { ...drafts, ...pendingDrafts },
    });
    loaded = true;
  })();

  return {
    persisted: diskPath !== null,
    ready,
    state,
    getItem(index) {
      return get(state).items[index];
    },
    getDraft(index) {
      return get(state).drafts[index];
    },
    setItem(item) {
      state.update((current) => ({
        items: { ...current.items, [item.index]: item },
        drafts: omitDraft(current.drafts, item.index),
      }));
      if (!loaded) pendingItems[item.index] = item;
      writeDrafts();
      if (!diskPath) {
        writeStorage(itemsKey, parasItemsToDocument(Object.values(get(state).items)));
        return;
      }
      // Serialise client-side as well; Rust merges under its own Mutex.
      writeChain = writeChain
        .then(() => invoke("paras_store", { path: diskPath, item }))
        .then(() => undefined)
        .catch(() => undefined);
    },
    setDraft(index, text) {
      state.update((current) => ({
        items: current.items,
        drafts: { ...current.drafts, [index]: text },
      }));
      if (!loaded) pendingDrafts[index] = text;
      writeDrafts();
    },
    clearDraft(index) {
      state.update((current) => ({
        items: current.items,
        drafts: omitDraft(current.drafts, index),
      }));
      if (!loaded) delete pendingDrafts[index];
      writeDrafts();
    },
  };
}

const sessions = new Map<string, ParasSession>();

/** One session per document, shared by the action, the toolbar and the grader. */
export function getParasSession(
  tabId: string | null,
  filePath: string | null,
  memoryKey: string | null = null,
): ParasSession {
  const key = isDiskCacheablePath(filePath)
    ? parasCachePath(filePath!)
    : memoryKey ?? tabId ?? "untitled";
  const found = sessions.get(key);
  if (found) return found;
  const session = createParasSession({ filePath, memoryKey: key });
  sessions.set(key, session);
  return session;
}

/** Paragraph list published by the running mode, keyed by tab id. */
export interface ParasSnapshotEntry {
  index: number;
  text: string;
  hash: string;
}

export interface ParasDocumentInfo {
  total: number;
  entries: ParasSnapshotEntry[];
}

export const parasDocuments = writable<Record<string, ParasDocumentInfo>>({});

export function publishParasDocument(tabId: string, info: ParasDocumentInfo): void {
  parasDocuments.update((current) => ({ ...current, [tabId]: info }));
}

export function removeParasDocument(tabId: string): void {
  parasDocuments.update((current) => {
    if (!(tabId in current)) return current;
    const next = { ...current };
    delete next[tabId];
    return next;
  });
}

export function getParasDocument(tabId: string): ParasDocumentInfo | undefined {
  return get(parasDocuments)[tabId];
}
