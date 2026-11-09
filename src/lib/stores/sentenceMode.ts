import { writable } from "svelte/store";

/** Whether the sentence ("句") reading mode is on. Persisted so it survives a
 *  restart; the toolbar's 句 button is a plain toggle on top of this. */
const STORAGE_KEY = "mdhero:sentence-mode";

function load(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const store = writable<boolean>(load());

store.subscribe((value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Restricted webview: the mode still works for this session.
  }
});

export const sentenceMode = {
  subscribe: store.subscribe,
  set: store.set,
  toggle: () => store.update((on) => !on),
};
