import { writable } from "svelte/store";

/**
 * Whether 词 mode shows IPA instead of the Chinese gloss in its bubbles.
 *
 * The reader flips this with the 音 button or the `4` shortcut while studying
 * pinned words: meanings first, then pronunciation, without losing the pins.
 * Persisted: reopening a document continues in the same view.
 */
const STORAGE_KEY = "mdhero:word-phonetic-view";

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const store = writable(stored());

export const wordPhoneticView = {
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
