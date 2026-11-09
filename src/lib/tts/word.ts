import { get } from "svelte/store";
import { translate } from "$lib/i18n";
import { ttsSettings } from "$lib/stores/tts";
import { showToast } from "$lib/stores/toast";
import { buildSpeechRequest, detectLanguage, hasSpeakableText } from "$lib/utils/tts";

/**
 * Alt+click pronunciation in the 词/句/段 modes: one word, sentence or paragraph
 * goes through the same Kokoro backend as read-aloud, but plays on its own
 * AudioContext so the document's timeline keeps running untouched.
 */

let context: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let abortCurrent: AbortController | null = null;
let requestId = 0;
let currentOnEnd: ((completed: boolean) => void) | null = null;

export interface SpeakOptions {
  /** Called once when this request ends naturally, fails, or is stopped by a
   *  newer request. `completed` is true only for a natural end. */
  onEnd?: (completed: boolean) => void;
}

function ensureContext(): AudioContext {
  if (!context) context = new AudioContext();
  if (context.state === "suspended") void context.resume().catch(() => {});
  return context;
}

function finishCurrent(completed: boolean): void {
  const callback = currentOnEnd;
  currentOnEnd = null;
  if (!callback) return;
  try {
    callback(completed);
  } catch {
    // A callback must never break playback teardown.
  }
}

function stopCurrent(): void {
  if (abortCurrent) {
    abortCurrent.abort();
    abortCurrent = null;
  }
  if (source) {
    const node = source;
    source = null;
    try {
      node.stop();
    } catch {
      // Already stopped; disconnect still releases the node.
    }
    node.disconnect();
  }
  finishCurrent(false);
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const unreachable =
    error instanceof TypeError ||
    /failed to fetch|network|load failed|connection|econnrefused/i.test(message);
  showToast(
    unreachable
      ? translate("speech.backendUnavailable", { url: get(ttsSettings).baseUrl })
      : translate("speech.failed", { err: message }),
    6000,
  );
}

async function fetchAudio(text: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const { baseUrl, speed } = get(ttsSettings);
  const chunk = { text, language: detectLanguage(text) };
  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSpeechRequest(chunk, speed)),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return response.arrayBuffer();
}

/** Speak one word, sentence or paragraph chunk, replacing whatever was playing. */
export function speakText(text: string, options: SpeakOptions = {}): void {
  const value = text.trim();
  if (!value || !hasSpeakableText(value)) {
    options.onEnd?.(false);
    return;
  }

  // Called synchronously from the click handler: unlocking the context now is
  // what lets audio that arrives after the network round-trip still play.
  let ctx: AudioContext;
  try {
    ctx = ensureContext();
  } catch (error) {
    reportError(error);
    options.onEnd?.(false);
    return;
  }

  // Bump the id before stopping so the old node's `ended` event cannot finish
  // the request that is about to start.
  const id = ++requestId;
  stopCurrent();
  currentOnEnd = options.onEnd ?? null;
  const abort = new AbortController();
  abortCurrent = abort;

  void (async () => {
    try {
      const data = await fetchAudio(value, abort.signal);
      if (id !== requestId) return;
      const buffer = await ctx.decodeAudioData(data);
      if (id !== requestId) return;

      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => {
        if (id !== requestId) return;
        if (source === node) source = null;
        node.disconnect();
        finishCurrent(true);
      };
      source = node;
      node.start();
    } catch (error) {
      if (id !== requestId) return;
      reportError(error);
      finishCurrent(false);
    }
  })();
}

/** Stop whatever `speakText` started (used by the paragraph card's stop button). */
export function stopTextSpeech(): void {
  requestId++;
  stopCurrent();
}
