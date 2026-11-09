import { writable } from "svelte/store";
import {
  TTS_BASE_URL,
  TTS_DEFAULT_SPEED,
  TTS_MAX_SPEED,
  TTS_MIN_SPEED,
  clampSpeed,
} from "../utils/tts";

/** Settings for the toolbar's read-aloud button. Stored locally, so the speed
 *  and the sentence highlight survive a restart, the same way the translation
 *  settings do. */
export interface TtsSettings {
  baseUrl: string;
  speed: number;
  /** Paint the sentence being read in the reading pane (right-click option). */
  highlight: boolean;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  baseUrl: TTS_BASE_URL,
  speed: TTS_DEFAULT_SPEED,
  highlight: false,
};

const STORAGE_KEY = "mdhero:tts";

function load(): TtsSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_TTS_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TTS_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<TtsSettings> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_TTS_SETTINGS };
    return {
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
        ? parsed.baseUrl.trim()
        : DEFAULT_TTS_SETTINGS.baseUrl,
      speed: typeof parsed.speed === "number"
        ? clampSpeed(parsed.speed)
        : DEFAULT_TTS_SETTINGS.speed,
      highlight: parsed.highlight === true,
    };
  } catch {
    return { ...DEFAULT_TTS_SETTINGS };
  }
}

const store = writable<TtsSettings>(load());

store.subscribe((value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Restricted webview: the speed still applies for this session.
  }
});

export const ttsSettings = {
  subscribe: store.subscribe,
  set: store.set,
  update: store.update,
};

/** Persist a new speech rate, clamped to the slider's 0.5–2.0 range. */
export function setTtsSpeed(speed: number): number {
  const next = clampSpeed(speed);
  store.update((value) => ({ ...value, speed: next }));
  return next;
}

/** Persist the read-aloud sentence highlight; it applies immediately, even
 *  while a document is already being read. */
export function setTtsHighlight(on: boolean): void {
  store.update((value) => ({ ...value, highlight: on }));
}

export { TTS_MIN_SPEED, TTS_MAX_SPEED, TTS_SPEED_STEP } from "../utils/tts";
