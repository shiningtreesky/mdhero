import { writable } from "svelte/store";

/**
 * Loop listening: while this is on, clicking a word, sentence or paragraph in
 * the reading modes repeats it until clicked again. The choice persists so a
 * study session continues after a restart.
 */
const STORAGE_KEY = "mdhero:loop-speech";

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const store = writable(stored());

/** Breath between two passes, in seconds. Editable from the loop button's
 *  right-click menu; every loop (段/句/词 and the whole-document player) reads
 *  it at the moment the gap starts, so a change lands on the next pause. */
export const LOOP_GAP_DEFAULT = 0.7;
export const LOOP_GAP_MIN = 0.1;
export const LOOP_GAP_MAX = 5;
const GAP_KEY = "mdhero:loop-gap";

/** Clamp to 0.1–5 s, two decimals; anything unreadable becomes the default. */
export function clampLoopGap(value: number): number {
  if (!Number.isFinite(value)) return LOOP_GAP_DEFAULT;
  return Math.round(Math.min(LOOP_GAP_MAX, Math.max(LOOP_GAP_MIN, value)) * 100) / 100;
}

function storedGap(): number {
  try {
    const raw = globalThis.localStorage?.getItem(GAP_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= LOOP_GAP_MIN && value <= LOOP_GAP_MAX
      ? value
      : LOOP_GAP_DEFAULT;
  } catch {
    return LOOP_GAP_DEFAULT;
  }
}

const gapStore = writable(storedGap());

export const loopGap = {
  subscribe: gapStore.subscribe,
  set(value: number) {
    const next = clampLoopGap(value);
    gapStore.set(next);
    try {
      globalThis.localStorage?.setItem(GAP_KEY, String(next));
    } catch {
      // Storage may be unavailable; the session still works.
    }
  },
};

export const loopSpeech = {
  subscribe: store.subscribe,
  set(value: boolean) {
    store.set(value);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Storage may be unavailable; the session still works.
    }
  },
  toggle() {
    store.update((on) => {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, on ? "0" : "1");
      } catch {
        // Ignore.
      }
      return !on;
    });
  },
};
