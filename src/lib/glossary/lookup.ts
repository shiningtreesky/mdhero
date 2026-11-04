import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { glossarySettings } from "$lib/stores/glossarySettings";
import { cleanGlossText, formatGloss } from "$lib/utils/glossary";

export interface GlossLookup {
  ok: boolean;
  /** Ready-to-show text: 1–2 meanings joined with " / ". */
  text: string;
  items: string[];
}

/** Ask the dictionary endpoint for a word. The request runs in Rust so a LAN
 *  endpoint is not blocked by CSP/CORS, and the model reply is cleaned down to
 *  at most two short Chinese meanings before it can reach the bubble. */
export async function lookupGloss(word: string): Promise<GlossLookup> {
  const settings = get(glossarySettings);
  try {
    const content = await invoke<string>("glossary_lookup", {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      word,
    });
    const items = cleanGlossText(content);
    if (items.length === 0) return { ok: false, text: "", items };
    return { ok: true, text: formatGloss(items), items };
  } catch {
    return { ok: false, text: "", items: [] };
  }
}
