import { invoke } from "@tauri-apps/api/core";
import { get, writable, type Writable } from "svelte/store";
import { translate } from "$lib/i18n";
import { showToast } from "$lib/stores/toast";
import { isDiskCacheablePath } from "$lib/glossary/cache";
import type { UnitKind } from "$lib/utils/paragraphs";

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

/** The unit list a saved document is reconciled against. */
export interface ParasUnitRef {
  index: number;
  hash: string;
}

export interface ParasRemapResult {
  items: ParaItem[];
  /** True when at least one index/hash/text changed and the file should be
   *  rewritten to keep the next load stable. */
  changed: boolean;
  /** Saved entries whose unit no longer exists (dropped). */
  orphaned: number;
}

/**
 * Re-attach saved translations after the unit numbering shifts — adding a
 * heading moves every later unit, so reading by `index` alone would hand a
 * paragraph's translation to a different unit.
 *
 *  - Units are matched by source hash first (a translation always follows its
 *    own source text, whichever number it now has; a paragraph can never
 *    silently become a heading because the hashes differ).
 *  - When several units share one hash, the one closest to the old index wins,
 *    so repeated texts (a table cell "Yes", "Yes") keep their order.
 *  - A leftover entry whose index still exists but whose hash no longer
 *    matches stays where it is: the UI flags it as "原文已变" and asks for a
 *    fresh confirmation instead of throwing the work away.
 *  - Anything else (document got shorter, slot already taken) is an orphan and
 *    is dropped.
 */
export function remapParasItems(
  items: readonly ParaItem[],
  units: readonly ParasUnitRef[],
): ParasRemapResult {
  const byHash = new Map<string, number[]>();
  for (const unit of units) {
    if (!unit.hash) continue;
    const list = byHash.get(unit.hash);
    if (list) list.push(unit.index);
    else byHash.set(unit.hash, [unit.index]);
  }
  const unitByIndex = new Map(units.map((unit) => [unit.index, unit]));
  const claimed = new Set<number>();
  const assigned = new Map<number, ParaItem>();
  const leftovers: ParaItem[] = [];

  const before = [...items].sort((a, b) => a.index - b.index);

  for (const item of before) {
    const candidates = item.hash
      ? (byHash.get(item.hash) ?? []).filter((index) => !claimed.has(index))
      : [];
    if (candidates.length === 0) {
      leftovers.push(item);
      continue;
    }
    let chosen = candidates[0];
    if (candidates.includes(item.index)) {
      chosen = item.index;
    } else {
      chosen = candidates.reduce((best, index) =>
        Math.abs(index - item.index) < Math.abs(best - item.index) ? index : best,
      );
    }
    claimed.add(chosen);
    assigned.set(chosen, { ...item, index: chosen });
  }

  for (const item of leftovers) {
    if (item.index < 0) continue;
    if (unitByIndex.has(item.index) && !claimed.has(item.index)) {
      claimed.add(item.index);
      assigned.set(item.index, item);
    }
  }

  const out = [...assigned.values()].sort((a, b) => a.index - b.index);
  const changed =
    out.length !== before.length ||
    out.some((item, i) => {
      const prev = before[i];
      return (
        !prev ||
        prev.index !== item.index ||
        prev.hash !== item.hash ||
        prev.text !== item.text ||
        prev.status !== item.status
      );
    });

  return { items: out, changed, orphaned: before.length - out.length };
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
  /** Re-attach saved entries to the current unit list (hash first, index
   *  second) and rewrite the cache when the numbering shifted. */
  reconcile(units: readonly ParasUnitRef[]): void;
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
    // This runs inside a `$derived` — `getParasSession` is called from
    // `activeParasSession` in +page.svelte. Writing to a store during a derived
    // computation throws `state_unsafe_mutation`, and that throw escapes the
    // store's subscriber flush with entries still queued: every later store
    // update is then enqueued but never delivered, which froze the whole UI
    // (labels stale, clicks dead) after the first save of a new document.
    // Defer the toast out of the derived computation.
    setTimeout(() => showToast(translate("paras.memoryOnly")), 0);
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
    if (!diskPath) {
      if (Object.keys(trimmed).length === 0) {
        try {
          globalThis.localStorage?.removeItem(draftsKey);
        } catch {
          // Storage may be unavailable; nothing to persist either way.
        }
        return;
      }
      writeStorage(draftsKey, JSON.stringify({ version: 1, drafts: trimmed }));
      return;
    }
    // With a real file the drafts live beside the confirmed translations, so
    // reopening the document brings back what was being typed.
    writeChain = writeChain
      .then(() => invoke("paras_drafts_store", { path: diskPath, drafts: trimmed }))
      .then(() => undefined)
      .catch(() => undefined);
  }

  const ready: Promise<void> = (async () => {
    let items: ParaItem[] = [];
    let storedDrafts: Record<number, string> = {};
    if (diskPath) {
      try {
        const text = await invoke<string | null>("paras_read", { path: diskPath });
        items = parseParasDocument(text);
        storedDrafts = parseParasDrafts(text);
      } catch {
        items = [];
      }
    } else {
      items = parseParasDocument(readStorage(itemsKey));
    }
    // Builds that predate drafts living in the file kept them in localStorage;
    // adopt them once so nothing typed earlier is lost.
    const legacy = parseParasDrafts(readStorage(draftsKey));
    const drafts = diskPath ? { ...legacy, ...storedDrafts } : legacy;
    state.set({
      items: { ...toRecord(items), ...pendingItems },
      drafts: { ...drafts, ...pendingDrafts },
    });
    loaded = true;
    if (diskPath && Object.keys(legacy).length > 0) {
      try {
        globalThis.localStorage?.removeItem(draftsKey);
      } catch {
        // Nothing to clean up.
      }
      if (Object.keys(storedDrafts).length === 0) writeDrafts();
    }
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
    reconcile(units) {
      const current = get(state).items;
      const items = Object.values(current);
      if (items.length === 0 || units.length === 0) return;
      const result = remapParasItems(items, units);
      if (!result.changed) return;
      state.update((state) => ({ items: toRecord(result.items), drafts: state.drafts }));
      if (!diskPath) {
        writeStorage(itemsKey, parasItemsToDocument(result.items));
        return;
      }
      // Rewrite the whole cache so the next load already sees the new indexes.
      writeChain = writeChain
        .then(() => invoke("paras_replace", { path: diskPath, items: result.items }))
        .then(() => undefined)
        .catch(() => undefined);
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
  kind: UnitKind;
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
