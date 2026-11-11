import { get, writable } from "svelte/store";
import { tabStore } from "$lib/stores/tabs";
import { loopSpeech } from "$lib/stores/loopSpeech";
import { setTtsSpeed, ttsSettings } from "$lib/stores/tts";
import { showToast } from "$lib/stores/toast";
import { translate } from "$lib/i18n";
import {
  buildSpeechPlan,
  buildSpeechRequest,
  synthesizeChunkWithFallback,
  type SpeechChunk,
  type SpeechPlan,
} from "$lib/utils/tts";
import { SpeechPlayer, type PlaybackState } from "./player";
import {
  locateSentence,
  sentenceTimings,
  type ChunkSpan,
  type SentenceTiming,
} from "./timeline";
import {
  audioCachePaths,
  appendCacheChunk,
  beginCacheWrite,
  deleteCacheFile,
  encoderAvailable,
  finalizeCache,
  hasValidCache,
  hashDocument,
  isCacheableDocumentPath,
  isTauriRuntime,
  readCacheMeta,
  readCachedAudio,
  stripId3Tags,
} from "./cache";

/** What the toolbar's play button shows: the player's own states, idle included. */
export type SpeechState = PlaybackState;

export const speechState = writable<SpeechState>("idle");

export interface SpeechProgress {
  /** Current document time, seconds. */
  position: number;
  /** Audio that exists so far — the slider's upper bound while generating. */
  duration: number;
  /** Whole-document duration, known after a cache hit or once generation ends. */
  total: number | null;
  /** 0–100 while synthesizing, `null` when no generation is running. */
  generation: number | null;
  /** True when the audio being played came from (or was written to) disk. */
  cached: boolean;
  /** Real bitrate of the cache file, as reported by the sidecar / ffmpeg. */
  bitrate: number | null;
}

const EMPTY_PROGRESS: SpeechProgress = {
  position: 0,
  duration: 0,
  total: null,
  generation: null,
  cached: false,
  bitrate: null,
};

export const speechProgress = writable<SpeechProgress>(EMPTY_PROGRESS);

/** The sentence currently being read, for the reading pane's highlight. It
 *  carries the tab it was spoken from, so only that pane paints. */
export interface SpokenSentence {
  tabId: string;
  text: string;
}

export const speechSentence = writable<SpokenSentence | null>(null);

/** Sentence → audio mapping of the run in flight. */
let plan: SpeechPlan | null = null;
let chunkSpans: Array<ChunkSpan | null> = [];
let timings: SentenceTiming[] = [];
let timingIndex = -1;

function clearSentence(): void {
  plan = null;
  chunkSpans = [];
  timings = [];
  timingIndex = -1;
  speechSentence.set(null);
}

/** Publish the sentence at `position`; the store only changes once per
 *  sentence, so the highlighter is not woken up by every progress tick. */
function publishSentence(position: number): void {
  if (!plan || !startedTabId) return;
  const index = locateSentence(timings, position);
  if (index === timingIndex) return;
  timingIndex = index;
  if (index < 0) {
    speechSentence.set(null);
    return;
  }
  speechSentence.set({ tabId: startedTabId, text: timings[index].text });
}

/** Recompute the mapping after another chunk landed on the timeline. */
function refreshTimings(): void {
  if (!plan) return;
  timings = sentenceTimings(plan, chunkSpans);
  publishSentence(player.position);
}

/** Keep generation at most this far ahead of playback, so a long document does
 *  not decode minutes of audio into memory before anyone hears it. */
const READ_AHEAD_SECONDS = 20;

let progress: SpeechProgress = { ...EMPTY_PROGRESS };
let startedTabId: string | null = null;
/** The exact markdown handed to the player, so a replacement (file watcher,
 *  translation, another document loaded into the tab) stops playback. */
let startedContent = "";
/** Bumped by every start/stop; every await compares against it and bails. */
let runId = 0;
let activeAbort: AbortController | null = null;
/** `.part.mp3` of the run in flight; deleted if the run is abandoned. */
let cleanupPart: string | null = null;
/** Tabs already told that they have no disk path to cache into. */
const warnedNoCache = new Set<string>();

/**
 * Sentence start times of a document that has been synthesized to disk.
 *
 * A cache hit decodes the whole file into one audio segment, so the chunk
 * boundaries are gone and the sentences would have to be placed by character
 * counts again — the exact reason the highlight used to lag. Remembering the
 * measured starts keeps the cache path as precise as live generation.
 */
const TIMINGS_KEY_PREFIX = "mdhero:tts-timings:";
const TIMINGS_MAX_ENTRIES = 50;

interface StoredTimings {
  at: number;
  spans: Array<[number, number]>;
}

function pruneTimings(keep: string): void {
  const keys: Array<{ key: string; at: number }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(TIMINGS_KEY_PREFIX) || key === keep) continue;
    let at = 0;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as StoredTimings | null;
      at = typeof parsed?.at === "number" ? parsed.at : 0;
    } catch {
      // Unreadable entry: treat it as the oldest and let the prune take it.
    }
    keys.push({ key, at });
  }
  if (keys.length < TIMINGS_MAX_ENTRIES) return;
  keys.sort((a, b) => a.at - b.at);
  for (const entry of keys.slice(0, keys.length - TIMINGS_MAX_ENTRIES + 1)) {
    localStorage.removeItem(entry.key);
  }
}

function rememberTimings(hash: string, values: SentenceTiming[]): void {
  if (!hash || values.length === 0 || typeof localStorage === "undefined") return;
  try {
    const key = TIMINGS_KEY_PREFIX + hash;
    const payload: StoredTimings = {
      at: Date.now(),
      // Milliseconds are plenty: one tenth of a syllable.
      spans: values.map((value) => [
        Math.round(value.start * 1000) / 1000,
        Math.round(value.end * 1000) / 1000,
      ]),
    };
    localStorage.setItem(key, JSON.stringify(payload));
    pruneTimings(key);
  } catch {
    // Storage disabled or full: the cache path falls back to character counts.
  }
}

function recallTimings(hash: string, speechPlan: SpeechPlan): SentenceTiming[] | null {
  if (!hash || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(TIMINGS_KEY_PREFIX + hash);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTimings> | null;
    const spans = parsed?.spans;
    if (!Array.isArray(spans) || spans.length !== speechPlan.sentences.length) return null;
    const out: SentenceTiming[] = [];
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!Array.isArray(span) || typeof span[0] !== "number" || typeof span[1] !== "number") {
        return null;
      }
      out.push({ text: speechPlan.sentences[i].text, start: span[0], end: span[1] });
    }
    return out;
  } catch {
    return null;
  }
}

function setProgress(patch: Partial<SpeechProgress>): void {
  progress = { ...progress, ...patch };
  speechProgress.set(progress);
}

function resetProgress(): void {
  progress = { ...EMPTY_PROGRESS };
  speechProgress.set(progress);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(error: unknown): void {
  const message = describe(error);
  const unreachable =
    error instanceof TypeError ||
    /failed to fetch|network|load failed|connection|econnrefused/i.test(message);
  showToast(
    unreachable
      ? translate("speech.backendUnavailable", { url: get(ttsSettings).baseUrl })
      : translate("speech.failed", { err: message }),
    8000,
  );
}

/** The breath between passes of the whole-document loop, matching 段/句/词. */
const LOOP_GAP_MS = 700;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRestart(): void {
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

const player = new SpeechPlayer({
  onState: (state) => {
    speechState.set(state);
    if (state === "idle") {
      startedTabId = null;
      startedContent = "";
      activeAbort = null;
      clearSentence();
    }
  },
  onProgress: (value) => {
    setProgress({
      position: value.position,
      duration: value.duration,
      total: value.complete ? value.duration : progress.total,
    });
    publishSentence(value.position);
  },
  // Whole-document loop: with the loop toggle on, a run that reached its end
  // starts over after the same breath the reading-mode loops use. A stop,
  // pause or tab switch never comes through here.
  onEnded: () => {
    cancelRestart();
    if (!get(loopSpeech)) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!get(loopSpeech) || isActive()) return;
      void startSpeech().catch((error) => {
        cancelCurrentRun();
        reportError(error);
      });
    }, LOOP_GAP_MS);
  },
  onError: reportError,
});

// Turning the loop off stops the document at once (the reader asked for that,
// rather than "finish this pass"); turning it on only arms the next finish.
loopSpeech.subscribe((on) => {
  if (on) return;
  cancelRestart();
  if (isActive()) stopSpeech();
});

function isActive(): boolean {
  return get(speechState) !== "idle";
}

/** Returns once the abandoned part file is gone, so a restart never races it. */
function cancelCurrentRun(): Promise<void> {
  runId++;
  // Any explicit stop also cancels a pending loop restart: pressing stop during
  // the breath must not have the next pass start under it.
  cancelRestart();
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  player.stop();
  let cleanup: Promise<void> = Promise.resolve();
  if (cleanupPart) {
    const part = cleanupPart;
    cleanupPart = null;
    cleanup = deleteCacheFile(part).catch(() => {});
  }
  startedTabId = null;
  startedContent = "";
  resetProgress();
  clearSentence();
  return cleanup;
}

/** Stop playback, abort generation, drop the half-written part file. */
export function stopSpeech(): void {
  void cancelCurrentRun();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Let playback catch up so generation never runs too far ahead of the reader. */
async function waitForReadAhead(run: number): Promise<void> {
  while (run === runId && player.generatedSeconds - player.position > READ_AHEAD_SECONDS) {
    await sleep(250);
  }
}

async function synthesize(
  chunk: SpeechChunk,
  speed: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(`${get(ttsSettings).baseUrl}/v1/audio/speech`, {
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

async function startSpeech(): Promise<void> {
  const tab = tabStore.getActiveTab();
  if (!tab) return;

  // One request per sentence: the segment boundaries then *are* the sentence
  // boundaries, so the highlight switches on the first syllable instead of
  // estimating where inside a packed chunk a sentence starts.
  const speechPlan = buildSpeechPlan(tab.content, undefined, { perSentence: true });
  const chunks = speechPlan.chunks;
  if (chunks.length === 0) {
    showToast(translate("speech.emptyDocument"), 5000);
    return;
  }

  // Before any await: this runs inside the click handler, and the gesture is
  // what unlocks the AudioContext for the audio that arrives seconds later.
  player.prepare();

  const run = ++runId;
  const speed = get(ttsSettings).speed;
  const cacheable = isTauriRuntime() && isCacheableDocumentPath(tab.filePath);

  // The rate is part of the key: a file synthesized at 1.0x is not the audio
  // the user asked for at 1.5x, so a speed change regenerates instead of reusing.
  // The trailing marker versions the key: audio packed several sentences into
  // one request has no sentence boundaries to place the highlight with, so it
  // is regenerated once at the new granularity.
  const hash = cacheable
    ? await hashDocument(`${tab.content}\u0000${speed}\u0000per-sentence`)
    : "";
  if (run !== runId) return;

  startedTabId = tab.id;
  startedContent = tab.content;
  resetProgress();
  cleanupPart = null;
  plan = speechPlan;
  chunkSpans = [];
  timings = [];
  timingIndex = -1;
  speechSentence.set(null);

  if (cacheable && (await hasValidCache(tab.filePath, hash)) && run === runId) {
    try {
      const meta = await readCacheMeta(tab.filePath);
      if (run !== runId) return;
      const data = await readCachedAudio(tab.filePath);
      if (run !== runId) return;
      setProgress({
        cached: true,
        bitrate: meta?.bitrate ?? null,
        total: meta?.duration ?? null,
      });
      // A cache hit decodes into one segment, so the chunk spans are unknown.
      // Measured sentence starts from the run that wrote the file place the
      // highlight exactly; only a file without them falls back to placing
      // sentences by their share of the whole text.
      timings = recallTimings(hash, speechPlan)
        ?? sentenceTimings(speechPlan, [], meta?.duration ?? 0);
      await player.startCached(data);
      if (run !== runId) return;
      if (timings.length === 0) {
        timings = sentenceTimings(speechPlan, [], player.generatedSeconds);
      }
      publishSentence(player.position);
      return;
    } catch {
      // A cache that exists but cannot be read or decoded is not usable;
      // regenerate and let finalize overwrite it.
      if (run !== runId) return;
      resetProgress();
    }
  } else if (!cacheable && !warnedNoCache.has(tab.id)) {
    warnedNoCache.add(tab.id);
    showToast(translate("speech.noCachePath"), 6000);
  }

  if (run !== runId) return;
  player.startLive();

  const abort = new AbortController();
  activeAbort = abort;
  const partPath = cacheable ? audioCachePaths(tab.filePath).part : null;
  let cacheWriting = false;
  let warnedWrite = false;
  let writtenBytes = 0;

  const warnWriteFailure = () => {
    if (warnedWrite) return;
    warnedWrite = true;
    showToast(translate("speech.cacheWriteFailed"), 6000);
  };

  // A chunk Kokoro cannot read is dropped, not fatal: tell the user once,
  // without stopping the audio that is already playing or that follows it.
  let warnedSkip = false;
  const warnSkipped = () => {
    if (warnedSkip) return;
    warnedSkip = true;
    showToast(translate("speech.chunkSkipped"), 6000);
  };

  if (cacheable && partPath) {
    try {
      await beginCacheWrite(tab.filePath);
      if (run !== runId) return;
      cacheWriting = true;
      cleanupPart = partPath;
    } catch {
      cacheWriting = false;
      warnWriteFailure();
    }
    if (cacheWriting) {
      void encoderAvailable().then((available) => {
        if (!available && run === runId) {
          showToast(translate("speech.encoderFallback"), 6500);
        }
      });
    }
  }

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (run !== runId) return;
      await waitForReadAhead(run);
      if (run !== runId) return;

      // A chunk that fails is retried, then split, then dropped — never a
      // reason to abandon the rest of the document.
      const outcome = await synthesizeChunkWithFallback(
        chunks[i],
        (chunk) => synthesize(chunk, speed, abort.signal),
        () => run !== runId || abort.signal.aborted,
      );
      if (run !== runId) return;
      if (outcome.skipped) warnSkipped();

      // A chunk may decode to several buffers when it had to be re-split; its
      // span on the timeline is the first buffer's start to the last one's end.
      let chunkStart: number | null = null;
      let chunkEnd = 0;

      for (const raw of outcome.buffers) {
        let buffer: AudioBuffer;
        try {
          buffer = await player.decode(raw);
        } catch {
          warnSkipped();
          continue;
        }
        if (run !== runId) return;
        const before = player.generatedSeconds;
        player.appendSegment(buffer);
        if (chunkStart === null) chunkStart = before;
        chunkEnd = player.generatedSeconds;

        if (cacheWriting) {
          try {
            // Each Kokoro chunk carries its own ID3v2 tag; concatenating those
            // confuses decoders, so strip them before appending frames.
            const frames = stripId3Tags(new Uint8Array(raw));
            if (frames.length > 0) {
              await appendCacheChunk(tab.filePath, frames);
              writtenBytes += frames.length;
            }
          } catch {
            cacheWriting = false;
            cleanupPart = null;
            warnWriteFailure();
          }
        }
      }

      if (chunkStart !== null) {
        chunkSpans[i] = { start: chunkStart, end: chunkEnd };
        refreshTimings();
      }

      setProgress({ generation: Math.round(((i + 1) / chunks.length) * 100) });
    }

    player.markComplete();
    setProgress({ generation: null, total: player.generatedSeconds });

    // Keep the measured starts with the cache file, so replaying it from disk
    // places the highlight just as exactly. Only a run that covered every
    // sentence can be stored; a skipped chunk would misalign the rest.
    if (timings.length === speechPlan.sentences.length) {
      rememberTimings(hash, timings);
    }

    if (cacheWriting && writtenBytes > 0) {
      // The part file is complete; Rust turns it into the final 192 kbps file.
      // Do not delete it if the user presses stop while ffmpeg runs — that
      // would throw away a cache that is already valid.
      cleanupPart = null;
      try {
        const bitrate = await finalizeCache(
          tab.filePath,
          hash,
          tab.content.length,
          player.generatedSeconds,
        );
        if (run === runId) setProgress({ cached: true, bitrate });
      } catch (error) {
        if (partPath) void deleteCacheFile(partPath).catch(() => {});
        if (run === runId) {
          showToast(translate("speech.cacheFinalizeFailed", { err: describe(error) }), 7000);
        }
      }
    } else if (cleanupPart) {
      const part = cleanupPart;
      cleanupPart = null;
      void deleteCacheFile(part).catch(() => {});
    }
  } catch (error) {
    if (run !== runId) return;
    cancelCurrentRun();
    reportError(error);
  }
}

/** One entry point for the toolbar button: play, pause, resume or cancel. */
export function toggleSpeech(): void {
  const state = get(speechState);
  if (state === "playing") {
    player.pause();
    return;
  }
  if (state === "paused") {
    player.resume();
    return;
  }
  if (state === "loading") {
    stopSpeech();
    return;
  }
  void startSpeech().catch((error) => {
    cancelCurrentRun();
    reportError(error);
  });
}

/** Jump to a document time; clamped to the audio that already exists. */
export function seekSpeech(time: number): void {
  player.seek(time);
}

let speedRestartTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Change the rate and keep it persisted. Audio is synthesized at one rate, and
 * the cache file is keyed by it, so an active run restarts at the new rate —
 * debounced, because dragging the slider emits one input event per step.
 */
export function changeSpeechSpeed(speed: number): void {
  const previous = get(ttsSettings).speed;
  const next = setTtsSpeed(speed);
  if (Math.abs(next - previous) < 0.001) return;
  if (!isActive()) return;

  if (speedRestartTimer !== null) clearTimeout(speedRestartTimer);
  speedRestartTimer = setTimeout(() => {
    speedRestartTimer = null;
    if (!isActive()) return;
    void cancelCurrentRun()
      .then(() => startSpeech())
      .catch((error) => {
        void cancelCurrentRun();
        reportError(error);
      });
  }, 350);
}

// Switching tabs while speaking must never leave A's audio playing under B.
tabStore.activeTabId.subscribe((id) => {
  if (!isActive() || !startedTabId) return;
  if (id !== startedTabId) stopSpeech();
});

// The active tab's content being replaced (file watcher, translation, a new
// document loaded into it) invalidates the audio being read.
tabStore.tabs.subscribe((tabs) => {
  if (!isActive() || !startedTabId) return;
  const tab = tabs.find((t) => t.id === startedTabId);
  if (!tab || tab.content !== startedContent) stopSpeech();
});
