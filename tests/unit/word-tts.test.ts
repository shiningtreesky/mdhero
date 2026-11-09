import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speakText, stopTextSpeech } from "../../src/lib/tts/word";

/** Minimal Web Audio stand-ins: `speakText` only needs a source node whose
 *  `ended` event the test can fire when it wants playback to finish. */
class FakeSource {
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}

const sources: FakeSource[] = [];

class FakeAudioContext {
  state = "running";
  destination = {};
  createBufferSource() {
    const source = new FakeSource();
    sources.push(source);
    return source;
  }
  decodeAudioData() {
    return Promise.resolve({} as AudioBuffer);
  }
  resume() {
    return Promise.resolve();
  }
}

function lastSource(): FakeSource {
  return sources[sources.length - 1];
}

beforeEach(() => {
  sources.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })),
  );
});

afterEach(() => {
  stopTextSpeech();
  vi.unstubAllGlobals();
});

describe("speakText completion", () => {
  it("reports a natural end", async () => {
    const onEnd = vi.fn();
    speakText("hello", { onEnd });
    await vi.waitFor(() => expect(sources.length).toBe(1));
    lastSource().onended?.();
    expect(onEnd).toHaveBeenCalledWith(true);
  });

  it("reports a stop as not completed", async () => {
    const onEnd = vi.fn();
    speakText("hello", { onEnd });
    await vi.waitFor(() => expect(sources.length).toBe(1));
    stopTextSpeech();
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it("reports the previous request as not completed when replaced", async () => {
    const first = vi.fn();
    speakText("hello", { onEnd: first });
    await vi.waitFor(() => expect(sources.length).toBe(1));

    const second = vi.fn();
    speakText("world", { onEnd: second });
    expect(first).toHaveBeenCalledWith(false);

    await vi.waitFor(() => expect(sources.length).toBe(2));
    lastSource().onended?.();
    expect(second).toHaveBeenCalledWith(true);
  });
});
