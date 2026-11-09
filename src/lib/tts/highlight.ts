import { get } from "svelte/store";
import { supportsHighlight } from "$lib/glossary/shared";
import { ttsSettings } from "$lib/stores/tts";
import { collectParagraphs } from "$lib/utils/paragraphs";
import { sentenceRanges } from "$lib/utils/sentence-dom";
import { findSentence } from "$lib/utils/speech-match";
import { speechSentence } from "./speech";

/**
 * Svelte action behind the "highlight the spoken sentence" option.
 *
 * The read-aloud plan is built from the document source while the article is
 * the rendered DOM, so a sentence is matched by its text, in reading order,
 * starting from the last sentence that was painted. The match is forgiving on
 * purpose: the speech extractor drops inline code and raw HTML, and the two
 * sentence splitters (source vs rendered) do not always agree, so a shared
 * prefix is enough to consider it the same sentence.
 *
 * Painting uses the CSS Custom Highlight API, exactly like the 句 mode: the
 * article's DOM is never touched, so highlights cannot disturb rendering,
 * selection or the other reading modes.
 */

const DEFAULT_HIGHLIGHT_NAME = "mdhero-speech";

export interface SpeechHighlightParams {
  /** The tab whose document this pane shows; only the speaking tab paints. */
  tabId: string | null;
  /**
   * Highlight registry name. Each pane needs its own: both panes live in the
   * same registry, and the pane that is not speaking clears its own name on
   * every update — with a shared name that clear would erase the other pane's
   * sentence, depending on which action happens to run last.
   */
  name?: string;
}

interface IndexedSentence {
  text: string;
  range: Range;
}

function injectStyles(name: string): void {
  const id = `style-${name}`;
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  // Same amber wash as the 句 mode's sentence hover, light and dark alike.
  style.textContent = `::highlight(${name}) { background-color: rgba(234, 179, 8, 0.18); }`;
  document.head.appendChild(style);
}

export function speechHighlight(node: HTMLElement, params: SpeechHighlightParams) {
  if (!supportsHighlight()) {
    return { update(_next: SpeechHighlightParams) {}, destroy() {} };
  }

  const name = params.name ?? DEFAULT_HIGHLIGHT_NAME;
  injectStyles(name);
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (range: Range) => unknown })
    .Highlight;

  let current = params;
  let sentences: IndexedSentence[] | null = null;
  let cursor = 0;
  /** The spoken text currently painted; skips redundant repaints. */
  let painted = "";
  let observer: MutationObserver | null = null;
  let observedArticle: HTMLElement | null = null;

  function findArticle(): HTMLElement | null {
    return node.querySelector<HTMLElement>("article.md-content");
  }

  function rebuild(article: HTMLElement): void {
    sentences = [];
    for (const unit of collectParagraphs(article)) {
      for (const sentence of sentenceRanges(unit.element, { skipInlineCode: true })) {
        sentences.push({ text: sentence.text, range: sentence.range });
      }
    }
    cursor = 0;
  }

  function clear(): void {
    painted = "";
    registry?.delete(name);
  }

  function render(): void {
    if (!current.tabId || !get(ttsSettings).highlight) {
      clear();
      cursor = 0;
      return;
    }

    const spoken = get(speechSentence);
    if (!spoken || spoken.tabId !== current.tabId) {
      clear();
      cursor = 0;
      return;
    }
    if (spoken.text === painted) return;

    const article = findArticle();
    if (!article) {
      clear();
      return;
    }
    if (article !== observedArticle) {
      observer?.disconnect();
      observedArticle = article;
      observer = new MutationObserver(() => {
        // A re-render replaced the article's nodes: every Range is stale.
        sentences = null;
        clear();
        render();
      });
      observer.observe(article, { childList: true, subtree: true, characterData: true });
    }
    let index = sentences;
    if (!index || index.length === 0) {
      rebuild(article);
      index = sentences;
    }
    if (!index || index.length === 0) {
      clear();
      return;
    }

    const hit = findSentence(index, spoken.text, cursor);
    if (!hit) {
      clear();
      return;
    }
    cursor = hit.next % index.length;
    painted = spoken.text;
    if (HighlightCtor && registry) {
      registry.set(name, new HighlightCtor(hit.entry.range));
    }
  }

  const unsubscribeSentence = speechSentence.subscribe(render);
  const unsubscribeSettings = ttsSettings.subscribe(render);
  render();

  return {
    update(next: SpeechHighlightParams) {
      const changed = next.tabId !== current.tabId;
      current = next;
      if (changed) {
        sentences = null;
        cursor = 0;
        clear();
      }
      render();
    },
    destroy() {
      unsubscribeSentence();
      unsubscribeSettings();
      observer?.disconnect();
      observer = null;
      clear();
    },
  };
}
