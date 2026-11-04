import { writable } from "svelte/store";

/** Settings for the toolbar's cn / en translation buttons. Stored locally so
 *  the endpoint survives restarts; the API key is intentionally kept in the
 *  same local store as the rest (this is a desktop app, not a cloud service). */
export interface TranslationSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  cnSuffix: string;
  enSuffix: string;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  baseUrl: "http://192.168.1.13:1234",
  apiKey: "1234",
  model: "hy-mt2-1.8b",
  cnSuffix: "-hero-cn",
  enSuffix: "-hero-en",
};

const STORAGE_KEY = "mdhero:translation";

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function load(): TranslationSettings {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_TRANSLATION_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TRANSLATION_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<TranslationSettings> | null;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_TRANSLATION_SETTINGS };
    }
    return {
      baseUrl: asString(parsed.baseUrl, DEFAULT_TRANSLATION_SETTINGS.baseUrl),
      apiKey: asString(parsed.apiKey, DEFAULT_TRANSLATION_SETTINGS.apiKey),
      model: asString(parsed.model, DEFAULT_TRANSLATION_SETTINGS.model),
      cnSuffix: asString(parsed.cnSuffix, DEFAULT_TRANSLATION_SETTINGS.cnSuffix),
      enSuffix: asString(parsed.enSuffix, DEFAULT_TRANSLATION_SETTINGS.enSuffix),
    };
  } catch {
    return { ...DEFAULT_TRANSLATION_SETTINGS };
  }
}

const store = writable<TranslationSettings>(load());

store.subscribe((value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in a restricted webview; the current session
    // still works, it just won't survive a restart.
  }
});

export const translationSettings = {
  subscribe: store.subscribe,
  set: store.set,
  update: store.update,
};

export function resetTranslationSettings(): void {
  store.set({ ...DEFAULT_TRANSLATION_SETTINGS });
}
