import { writable } from "svelte/store";

/** 段 mode has two workflows:
 *  - reading (default): whole-paragraph translations, pinned like 句 mode;
 *  - answer: the original card + grading workflow, behind the 回答模式 switch.
 *  Both toggles live in the 段 button's right-click menu and persist. */
const ANSWER_KEY = "mdhero:paras-answer";
const SPEAK_KEY = "mdhero:paras-speak";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function createFlag(key: string, fallback: boolean) {
  const store = writable(readFlag(key, fallback));
  return {
    subscribe: store.subscribe,
    set(value: boolean) {
      store.set(value);
      try {
        globalThis.localStorage?.setItem(key, value ? "1" : "0");
      } catch {
        // Storage may be unavailable; the session still works.
      }
    },
    toggle() {
      store.update((on) => {
        try {
          globalThis.localStorage?.setItem(key, on ? "0" : "1");
        } catch {
          // Ignore.
        }
        return !on;
      });
    },
  };
}

/** Answer mode: the card / grading workflow. Off means paragraph reading. */
export const parasAnswerMode = createFlag(ANSWER_KEY, false);

/** Reading mode: clicking a paragraph also reads it aloud. */
export const parasSpeak = createFlag(SPEAK_KEY, true);
