/**
 * Web Audio playback with a single, document-wide timeline.
 *
 * Audio arrives as one decoded buffer per speech chunk, but the UI must be able
 * to seek in *document time*. So every buffer is placed at its cumulative
 * start, and playback always runs one segment at a time from a (segment,
 * offset) pair. When generation has not caught up, the player waits on the
 * next segment instead of stopping, which is what makes "synthesize and play
 * as you go" feel continuous.
 *
 * The same player serves a cache hit: the whole MP3 is decoded into one
 * segment whose duration is the entire document.
 */

export type PlaybackState = "idle" | "loading" | "playing" | "paused";

/** Position and seekable range, emitted on every state change and while playing. */
export interface PlaybackProgress {
  /** Current document time in seconds. */
  position: number;
  /** How much audio exists so far — the furthest the slider may go. */
  duration: number;
  /** True once every chunk has been queued. */
  complete: boolean;
}

export interface SpeechPlayerOptions {
  onState: (state: PlaybackState) => void;
  onProgress: (progress: PlaybackProgress) => void;
  onError: (error: unknown) => void;
}

interface Segment {
  buffer: AudioBuffer;
  start: number;
  duration: number;
}

export class SpeechPlayer {
  private readonly options: SpeechPlayerOptions;
  /** Created once per session and kept alive: a context that was unlocked by
   *  the first click stays unlocked, so later starts need no extra gesture. */
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private segments: Segment[] = [];
  private generated = 0;
  private complete = false;
  private index = 0;
  private offset = 0;
  private startedAt = 0;
  private state: PlaybackState = "idle";
  private paused = false;
  private waiting = false;
  private frozenPosition = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Bumped whenever a run is replaced, so stale callbacks can bail out. */
  private run = 0;

  constructor(options: SpeechPlayerOptions) {
    this.options = options;
  }

  getState(): PlaybackState {
    return this.state;
  }

  /** Document time at which playback currently sits. */
  get position(): number {
    return this.currentPosition();
  }

  /** Seconds of audio that have been generated (the seekable range). */
  get generatedSeconds(): number {
    return this.generated;
  }

  /**
   * Called synchronously from the click handler, before any await: that gesture
   * is what lets the context start playing later.
   */
  prepare(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  /** Begin a run whose segments will be appended by the caller one by one. */
  startLive(): void {
    this.resetState();
    this.prepare();
    this.emit("loading");
    this.emitProgress();
  }

  /** Begin a run from a complete, already cached file. */
  async startCached(data: ArrayBuffer): Promise<void> {
    this.resetState();
    this.prepare();
    const run = this.run;
    this.emit("loading");
    const ctx = this.ctx;
    if (!ctx) throw new Error("Audio context unavailable");

    const buffer = await ctx.decodeAudioData(data.slice(0));
    if (run !== this.run) return;

    this.segments = [{ buffer, start: 0, duration: buffer.duration }];
    this.generated = buffer.duration;
    this.complete = true;
    this.playFrom(0, 0);
  }

  /** Decode one synthesized chunk without touching the timeline. */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("Audio context unavailable");
    return ctx.decodeAudioData(data.slice(0));
  }

  /** Add the next chunk to the end of the timeline and keep playing. */
  appendSegment(buffer: AudioBuffer): void {
    if (this.state === "idle") return;
    this.segments.push({ buffer, start: this.generated, duration: buffer.duration });
    this.generated += buffer.duration;

    if (this.state === "loading") {
      this.playFrom(this.index, this.offset);
      return;
    }
    if (this.waiting && !this.paused) {
      this.playFrom(this.index, this.offset);
      return;
    }
    this.emitProgress();
  }

  /** Every chunk has been queued; playback stops only at the real end. */
  markComplete(): void {
    if (this.state === "idle") return;
    this.complete = true;
    if (this.waiting && this.index >= this.segments.length) {
      this.finish();
      return;
    }
    this.emitProgress();
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.frozenPosition = this.currentPosition();
    this.detachSource();
    this.paused = true;
    this.waiting = false;
    this.clearTimer();
    this.emit("paused");
    this.emitProgress();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.paused = false;
    this.locate(this.frozenPosition);
    this.playFrom(this.index, this.offset);
  }

  /** Jump to any point that has already been generated (or the whole file). */
  seek(time: number): void {
    if (this.state === "idle" || this.generated <= 0) return;
    const target = Math.max(0, Math.min(time, this.generated));
    this.detachSource();
    this.locate(target);
    this.frozenPosition = target;

    if (this.state === "playing" && !this.paused) {
      this.playFrom(this.index, this.offset);
      return;
    }
    this.emitProgress();
  }

  /** Stop and reset; the AudioContext is reused by the next run. */
  stop(): void {
    this.resetState();
    this.emit("idle");
    this.options.onProgress({ position: 0, duration: 0, complete: false });
  }

  private resetState(): void {
    this.run++;
    this.detachSource();
    this.clearTimer();
    this.segments = [];
    this.generated = 0;
    this.complete = false;
    this.index = 0;
    this.offset = 0;
    this.paused = false;
    this.waiting = false;
    this.frozenPosition = 0;
  }

  private finish(): void {
    this.resetState();
    this.emit("idle");
    this.options.onProgress({ position: 0, duration: 0, complete: false });
  }

  private detachSource(): void {
    if (!this.source) return;
    this.source.onended = null;
    try {
      this.source.stop();
    } catch {
      // A source that already ended throws; nothing left to stop.
    }
    this.source = null;
  }

  private currentPosition(): number {
    if (this.state === "playing" && this.source && this.ctx) {
      const segment = this.segments[this.index];
      if (segment) {
        const elapsed = this.ctx.currentTime - this.startedAt;
        return Math.min(segment.start + Math.max(0, elapsed), segment.start + segment.duration);
      }
    }
    return Math.min(this.frozenPosition, this.generated);
  }

  /** Map a document time to the segment that contains it. */
  private locate(time: number): void {
    let i = 0;
    while (i < this.segments.length && time >= this.segments[i].start + this.segments[i].duration) {
      i++;
    }
    this.index = i;
    this.offset = i < this.segments.length ? time - this.segments[i].start : 0;
  }

  private playFrom(index: number, offset: number): void {
    if (this.state === "idle") return;
    this.index = index;
    this.offset = offset;
    const segment = this.segments[index];

    if (!segment) {
      // Generation has not reached this point yet. Keep the state as "playing"
      // so the button stays a pause button; appendSegment() resumes the sound.
      this.waiting = true;
      this.frozenPosition = this.generated;
      if (this.complete) {
        this.finish();
        return;
      }
      this.emit("playing");
      this.emitProgress();
      return;
    }

    if (offset >= segment.duration - 0.02) {
      this.playFrom(index + 1, 0);
      return;
    }

    this.waiting = false;
    const source = this.ctx!.createBufferSource();
    source.buffer = segment.buffer;
    source.connect(this.ctx!.destination);
    this.source = source;
    const run = this.run;
    this.startedAt = this.ctx!.currentTime - offset;
    source.onended = () => this.handleEnded(run);
    this.emit("playing");
    this.startTimer();
    source.start(0, offset);
    this.emitProgress();
  }

  private handleEnded(run: number): void {
    if (run !== this.run) return;
    const segment = this.segments[this.index];
    this.frozenPosition = segment ? segment.start + segment.duration : this.generated;
    this.source = null;
    this.index++;
    this.offset = 0;

    if (this.index >= this.segments.length) {
      this.waiting = true;
      this.frozenPosition = this.generated;
      if (this.complete) {
        this.finish();
        return;
      }
      this.emitProgress();
      return;
    }
    this.playFrom(this.index, 0);
  }

  private startTimer(): void {
    this.clearTimer();
    // 80 ms keeps the read-aloud highlight within a frame or two of the audio
    // when the next segment starts; 250 ms was visibly late on short sentences.
    this.timer = setInterval(() => this.emitProgress(), 80);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private emit(state: PlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    if (state !== "playing") this.clearTimer();
    this.options.onState(state);
  }

  private emitProgress(): void {
    this.options.onProgress({
      position: this.currentPosition(),
      duration: this.generated,
      complete: this.complete,
    });
  }
}
