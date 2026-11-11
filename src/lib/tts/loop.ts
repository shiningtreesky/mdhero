import { get, writable } from "svelte/store";
import { loopGap } from "$lib/stores/loopSpeech";
import { speakText, stopTextSpeech } from "./word";

/** What is repeating right now: the reading mode's own key plus the text.
 *  Reading actions subscribe and paint their own highlight/bubble from it. */
export interface LoopTarget {
  key: string;
  text: string;
}

export const looping = writable<LoopTarget | null>(null);

/** Breath between repeats, read from the user setting (default 0.7 s). */
function gapMs(): number {
  return Math.round(get(loopGap) * 1000);
}

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
        if (current !== target) return;
        if (!completed) {
          // Something else took over playback (the toolbar player, a new
          // request): end the loop too, so the highlight never stays on a
          // target that is no longer sounding.
          stopLoop();
          return;
        }
        // The breath before the next pass; every mode hears the same gap.
        timer = setTimeout(play, gapMs());
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
