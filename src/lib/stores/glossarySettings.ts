import { writable } from "svelte/store";

/** Endpoint for the reading mode's dictionary lookups. Deliberately separate
 *  from `translationSettings`: the gloss model is usually a small local one, and
 *  pointing it at a different server should not disturb translation. */
export interface GlossarySettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Left-clicking a word in reading mode also speaks it aloud. */
  speakOnClick: boolean;
}

export const DEFAULT_GLOSSARY_SETTINGS: GlossarySettings = {
  baseUrl: "http://192.168.1.13:1234",
  apiKey: "1234",
  model: "hy-mt2-1.8b",
  speakOnClick: false,
};

const STORAGE_KEY = "mdhero:glossary";

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function load(): GlossarySettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_GLOSSARY_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GLOSSARY_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GlossarySettings> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_GLOSSARY_SETTINGS };
    return {
      baseUrl: asString(parsed.baseUrl, DEFAULT_GLOSSARY_SETTINGS.baseUrl),
      apiKey: asString(parsed.apiKey, DEFAULT_GLOSSARY_SETTINGS.apiKey),
      model: asString(parsed.model, DEFAULT_GLOSSARY_SETTINGS.model),
      speakOnClick: asBoolean(parsed.speakOnClick, DEFAULT_GLOSSARY_SETTINGS.speakOnClick),
    };
  } catch {
    return { ...DEFAULT_GLOSSARY_SETTINGS };
  }
}

const store = writable<GlossarySettings>(load());

store.subscribe((value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Restricted webview: the endpoint still works for this session.
  }
});

export const glossarySettings = {
  subscribe: store.subscribe,
  set: store.set,
  update: store.update,
};

export function resetGlossarySettings(): void {
  store.set({ ...DEFAULT_GLOSSARY_SETTINGS });
}
