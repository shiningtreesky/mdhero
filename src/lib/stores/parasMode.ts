import { writable } from "svelte/store";

/** Whether the paragraph reading ("段") mode is on. The toolbar's 段 button
 *  toggles it; opening it switches the 词 mode off, because the two paint
 *  overlapping highlights over the same article. */
const STORAGE_KEY = "mdhero:paras-mode";

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

export const parasMode = {
  subscribe: store.subscribe,
  set: store.set,
  toggle: () => store.update((on) => !on),
};
