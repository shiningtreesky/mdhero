import { Channel, invoke } from "@tauri-apps/api/core";

export type StreamEvent = { type: "delta"; text: string } | { type: "done" };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  onDelta: (text: string) => void;
}

/**
 * Ask the Rust side to call an OpenAI-compatible `/v1/chat/completions`
 * endpoint and relay each SSE delta over a Tauri channel. The fetch lives in
 * Rust so the app's CSP and browser CORS rules cannot block a LAN model.
 */
export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (event) => {
    if (event.type === "delta") options.onDelta(event.text);
  };

  await invoke("stream_chat_completion", {
    request: {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.2,
    },
    onEvent: channel,
  });
}
