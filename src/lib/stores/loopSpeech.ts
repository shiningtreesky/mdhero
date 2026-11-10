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
