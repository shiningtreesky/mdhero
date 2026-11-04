import { writable } from "svelte/store";

/** Endpoint used by 对比提交 (the paragraph grader). It is independent from
 *  both the translation and the word-gloss settings. */
export interface GraderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_GRADER_SETTINGS: GraderSettings = {
  baseUrl: "https://api.xiaomimimo.com/v1",
  apiKey: "sk-c4clggb6unju5ncejmy7rups3evfhgmknw1baa7vrtcu62r8",
  model: "mimo-v2.6-flash",
};

const STORAGE_KEY = "mdhero:grader";

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function load(): GraderSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_GRADER_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GRADER_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraderSettings> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_GRADER_SETTINGS };
    return {
      baseUrl: asString(parsed.baseUrl, DEFAULT_GRADER_SETTINGS.baseUrl),
      apiKey: asString(parsed.apiKey, DEFAULT_GRADER_SETTINGS.apiKey),
      model: asString(parsed.model, DEFAULT_GRADER_SETTINGS.model),
    };
  } catch {
    return { ...DEFAULT_GRADER_SETTINGS };
  }
}

const store = writable<GraderSettings>(load());

store.subscribe((value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Restricted webview: the endpoint still works for this session.
  }
});

export const graderSettings = {
  subscribe: store.subscribe,
  set: store.set,
  update: store.update,
};

/** A grader request needs an endpoint and a model; the key may be empty for
 *  local endpoints that do not check it. */
export function isGraderConfigured(settings: GraderSettings): boolean {
  return settings.baseUrl.trim().length > 0 && settings.model.trim().length > 0;
}

export function resetGraderSettings(): void {
  store.set({ ...DEFAULT_GRADER_SETTINGS });
}
