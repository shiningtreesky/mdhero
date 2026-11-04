import { get } from "svelte/store";
import { document as docStore } from "$lib/stores/document";
import { tabStore, type Tab } from "$lib/stores/tabs";
import type { TranslationSettings } from "$lib/stores/translation";
import { addRecentFile } from "$lib/stores/recents";
import { allowAssets, getBaseDir, saveFile, watchFile } from "$lib/tauri/files";
import { streamChatCompletion } from "$lib/tauri/translate";
import { renderFull } from "$lib/renderer/pipeline";
import { translate } from "$lib/i18n";
import {
  appendRawBlock,
  appendTranslatedBlock,
  buildTranslationPrompt,
  cleanTranslatedChunk,
  ensureTrailingNewline,
  isCodeOnlyChunk,
  splitFrontmatter,
  splitMarkdownIntoChunks,
  type TranslationDirection,
} from "$lib/utils/translation";

export interface RunTranslationOptions {
  sourceTab: Tab;
  sourceContent: string;
  targetPath: string;
  targetName: string;
  direction: TranslationDirection;
  settings: TranslationSettings;
  /** Asked once, after the whole document is translated. Returning false keeps
   *  the finished translation in its tab without writing it to disk. */
  confirmOverwrite: () => Promise<boolean>;
  /** Rough completion percentage (0-100), for the toolbar's progress state. */
  onProgress?: (percent: number) => void;
}

/** What became of the translated document:
 *  - `written`: saved to disk and watched;
 *  - `kept`: finished, but the user declined to overwrite an existing file;
 *  - `abandoned`: the tab was closed before the translation finished. */
export type TranslationOutcome = "written" | "kept" | "abandoned";

/** How often the growing translation is re-rendered into the viewer. */
const RENDER_INTERVAL_MS = 300;

/**
 * Run one translation end to end:
 *
 * 1. open a new tab next to the source tab, immediately, showing an empty
 *    preview of the translated (frontmatter-only) document,
 * 2. translate chunk by chunk, streaming each delta into that tab,
 * 3. once everything arrived, ask whether to overwrite; only then write the
 *    file. Nothing is written while the translation is in flight, so a failure
 *    can never leave a half-translated file behind.
 *
 * On failure the temporary tab is closed and the error is re-thrown for the
 * caller to show.
 */
export async function runTranslation(options: RunTranslationOptions): Promise<TranslationOutcome> {
  const { sourceTab, sourceContent, targetPath, targetName, direction, settings } = options;
  const baseDir = getBaseDir(targetPath);
  const { frontmatter, body } = splitFrontmatter(sourceContent);
  const chunks = splitMarkdownIntoChunks(body);
  if (chunks.length === 0) throw new Error(translate("translation.emptyDocument"));

  // A file has one tab. An older translation tab for the same path is replaced
  // only when it holds no unsaved edits; otherwise the edits would be lost
  // silently, so say what to do instead.
  const existing = get(tabStore.tabs).find((t) => t.filePath === targetPath);
  if (existing) {
    if (existing.dirty) {
      throw new Error(translate("translation.targetOpen", { name: existing.fileName }));
    }
    tabStore.closeTab(existing.id);
  }

  const initial = renderFull(frontmatter, baseDir);
  const tabId = tabStore.addTab(
    targetPath,
    targetName,
    frontmatter,
    initial.html,
    initial.frontmatter,
    initial.wordCount,
    sourceTab.pane,
    sourceTab.id,
  );

  let completed = frontmatter;
  let current = "";
  let lastRenderAt = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let translatedChars = 0;

  const tabExists = () => get(tabStore.tabs).some((t) => t.id === tabId);
  const currentContent = () => completed + current;

  const publishToDocument = (content: string, result: ReturnType<typeof renderFull>) => {
    if (get(tabStore.activeIds).left !== tabId) return;
    docStore.set({
      filePath: targetPath,
      fileName: targetName,
      content,
      renderedHtml: result.html,
      frontmatter: result.frontmatter,
      wordCount: result.wordCount,
      loading: false,
      error: null,
    });
  };

  const renderNow = (dirty = false) => {
    lastRenderAt = Date.now();
    const content = currentContent();
    const result = renderFull(content, baseDir);
    tabStore.updateStreamingContent(
      tabId,
      content,
      result.html,
      result.frontmatter,
      result.wordCount,
      dirty,
    );
    publishToDocument(content, result);
  };

  /** Update the viewer at a bounded rate; a long translation would otherwise
   *  re-render the whole document on every token. */
  const publish = (force = false) => {
    if (!tabExists()) return;
    const now = Date.now();
    if (force) {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      renderNow();
      return;
    }
    if (now - lastRenderAt >= RENDER_INTERVAL_MS) {
      renderNow();
    } else if (!renderTimer) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        renderNow();
      }, RENDER_INTERVAL_MS - (now - lastRenderAt));
    }
  };

  try {
    for (const chunk of chunks) {
      if (!tabExists()) return "abandoned";

      if (isCodeOnlyChunk(chunk)) {
        completed = appendRawBlock(completed, chunk);
        translatedChars += chunk.length;
        options.onProgress?.(Math.min(100, Math.round((translatedChars / body.length) * 100)));
        publish(true);
        continue;
      }

      current = "";
      let chunkChars = 0;
      await streamChatCompletion({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: [
          { role: "system", content: buildTranslationPrompt(direction) },
          { role: "user", content: chunk },
        ],
        onDelta: (delta) => {
          current += delta;
          chunkChars += delta.length;
          // The model's output length differs from the source's, so estimate
          // against the chunk: it reaches its own chunk's share when done.
          const ratio = Math.min(1, chunkChars / Math.max(1, chunk.length));
          options.onProgress?.(
            Math.min(99, Math.round(((translatedChars + chunk.length * ratio) / body.length) * 100)),
          );
          publish(false);
        },
      });

      const cleaned = cleanTranslatedChunk(current);
      if (!cleaned) throw new Error(translate("translation.emptyResponse"));
      completed = appendTranslatedBlock(completed, cleaned);
      translatedChars += chunk.length;
      current = "";
      publish(true);
    }

    if (!tabExists()) return "abandoned";

    const finalContent = ensureTrailingNewline(completed);
    const result = renderFull(finalContent, baseDir);
    tabStore.updateStreamingContent(
      tabId,
      finalContent,
      result.html,
      result.frontmatter,
      result.wordCount,
    );
    publishToDocument(finalContent, result);
    options.onProgress?.(100);

    // Nothing has touched the disk so far. Ask about an existing file now,
    // when there is a complete translation to keep in the tab either way.
    if (!(await options.confirmOverwrite())) {
      // Keep the finished translation, but mark it unsaved: Save will write
      // it, and closing the tab will offer to.
      tabStore.updateStreamingContent(
        tabId,
        finalContent,
        result.html,
        result.frontmatter,
        result.wordCount,
        true,
      );
      return "kept";
    }
    if (!tabExists()) return "abandoned";

    await saveFile(targetPath, finalContent);
    await allowAssets(result.assetPaths, targetPath);
    tabStore.finishStreaming(
      tabId,
      finalContent,
      result.html,
      result.frontmatter,
      result.wordCount,
    );
    publishToDocument(finalContent, result);
    // A full recent-files list or a restricted localStorage must not turn a
    // successfully written translation into a reported failure.
    try {
      addRecentFile(targetPath, targetName);
    } catch {}
    // Only watch a file that still has a tab; a closed tab has nothing to
    // reload, and leaving a handle open would be wasted work.
    if (tabExists()) watchFile(targetPath);
    return "written";
  } catch (err) {
    // The translation did not finish. Nothing was written, so removing the
    // temporary tab is all that is needed to leave no trace. If it was closed
    // by the user already, there is nothing to clean up either.
    if (tabExists()) tabStore.closeTab(tabId);
    throw err;
  } finally {
    if (renderTimer) clearTimeout(renderTimer);
  }
}
