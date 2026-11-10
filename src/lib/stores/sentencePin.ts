import { writable } from "svelte/store";

/** Whether clicked sentences stay pinned (highlight + translation) in 句 mode.
 *  Session only: the list itself is saved beside the document, this is just the
 *  toggle that decides whether those pins are shown. */
const store = writable(false);

export const sentencePinMode = {
  subscribe: store.subscribe,
  set: store.set,
  toggle: () => store.update((on) => !on),
};
