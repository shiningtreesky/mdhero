import { writable } from "svelte/store";

/** Whether clicked words stay pinned (highlight + gloss) in 词 mode. Session
 *  only: pinned words belong to the document being read and are cleared when
 *  the mode or tab changes, so there is nothing to restore on launch. */
const store = writable(false);

export const glossPinMode = {
  subscribe: store.subscribe,
  set: store.set,
  toggle: () => store.update((on) => !on),
};
