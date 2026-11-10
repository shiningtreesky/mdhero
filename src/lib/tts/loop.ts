import { writable } from "svelte/store";
import { speakText, stopTextSpeech } from "./word";

/** What is repeating right now: the reading mode's own key plus the text.
 *  Reading actions subscribe and paint their own highlight/bubble from it. */
export interface LoopTarget {
  key: string;
  text: string;
}

export const looping = writable<LoopTarget | null>(null);

/** Breath between repeats: long enough that two passes are heard as two. */
const GAP_MS = 700;

let timer: ReturnType<typeof setTimeout> | null = null;
let current: LoopTarget | null = null;

function clearGap(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Start repeating `target`, replacing whatever was repeating before. */
export function startLoop(target: LoopTarget): void {
  clearGap();
  current = target;
  looping.set(target);

  const play = (): void => {
    if (current !== target) return;
    speakText(target.text, {
      onEnd: (completed) => {
        if (!completed || current !== target) return;
        // The breath before the next pass; every mode hears the same gap.
        timer = setTimeout(play, GAP_MS);
      },
    });
  };
  play();
}

/** Stop repeating and silence the current pass. */
export function stopLoop(): void {
  clearGap();
  if (!current) return;
  current = null;
  looping.set(null);
  stopTextSpeech();
}

/** Stop only when `key` is the target; clicking elsewhere leaves a new loop
 *  alone. */
export function stopLoopFor(key: string): void {
  if (current?.key === key) stopLoop();
}
