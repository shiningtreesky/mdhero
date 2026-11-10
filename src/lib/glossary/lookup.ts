import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { glossarySettings, type GlossarySettings } from "$lib/stores/glossarySettings";
import {
  cleanGlossText,
  formatGloss,
  parsePhoneticReply,
  type Phonetic,
} from "$lib/utils/glossary";
import { cleanSentenceTranslation } from "$lib/utils/sentences";

export interface GlossLookup {
  ok: boolean;
  /** Ready-to-show text: 1–2 meanings joined with " / ", or one sentence translation. */
  text: string;
  items: string[];
  /** IPA, only when this lookup asked for it and the model answered. */
  phonetic?: Phonetic;
}

/** The IPA request is deliberately separate from the gloss request: a model
 *  that ignores the transcription format then cannot break the Chinese meaning,
 *  and a gloss reply that ignores IPA cannot be mistaken for "no IPA exists". */
async function lookupPhonetic(
  word: string,
  settings: GlossarySettings,
): Promise<Phonetic | undefined> {
  try {
    const content = await invoke<string>("glossary_lookup_phonetic", {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      word,
    });
    const reply = parsePhoneticReply(content);
    // No labels/fields means the model ignored the request; leave it undefined
    // so a later click retries instead of caching a permanent "no IPA" marker.
    return reply.attempted ? reply.phonetic : undefined;
  } catch {
    return undefined;
  }
}

/** Ask the dictionary endpoint for a word. The request runs in Rust so a LAN
 *  endpoint is not blocked by CSP/CORS, and the model reply is cleaned down to
 *  at most two short Chinese meanings before it can reach the bubble. When the
 *  音标 option is on, a second request fetches British/American IPA in parallel;
 *  either request can fail without taking the other one down.
 *
 *  `options.phonetic` forces the IPA request even when the 音标 setting is off:
 *  词 mode pre-fetches it so switching to the 音 view is instant. */
export async function lookupGloss(
  word: string,
  options: { phonetic?: boolean } = {},
): Promise<GlossLookup> {
  const settings = get(glossarySettings);
  const wantsPhonetic = options.phonetic ?? settings.showPhonetic;
  const phoneticTask = wantsPhonetic
    ? lookupPhonetic(word, settings)
    : Promise.resolve(undefined);

  try {
    const content = await invoke<string>("glossary_lookup", {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      word,
    });
    const items = cleanGlossText(content);
    const phonetic = await phoneticTask;
    if (items.length === 0) return { ok: false, text: "", items: [], phonetic };
    return { ok: true, text: formatGloss(items), items, phonetic };
  } catch {
    // Keep any IPA that did arrive so the bubble can still show it above the
    // failure message.
    const phonetic = await phoneticTask;
    return { ok: false, text: "", items: [], phonetic };
  }
}

/** Translate one sentence through the same endpoint/model as the word mode.
 *  The request runs in Rust for the same CSP/CORS reason as `lookupGloss`. */
export async function lookupSentence(sentence: string): Promise<GlossLookup> {
  const settings = get(glossarySettings);
  try {
    const content = await invoke<string>("glossary_lookup_sentence", {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      sentence,
    });
    const text = cleanSentenceTranslation(content);
    if (!text) return { ok: false, text: "", items: [] };
    return { ok: true, text, items: [text] };
  } catch {
    return { ok: false, text: "", items: [] };
  }
}
