<script lang="ts">
  import { onMount, tick } from "svelte";
  import { document as docStore } from "$lib/stores/document";
  import { tabStore, HOME_TAB_ID, type Tab } from "$lib/stores/tabs";
  import { initRenderer, renderFull, resolveLocalPath, isMarpDoc } from "$lib/renderer/pipeline";
  import {
    allowAssets,
    getBaseDir,
    newDocument,
    openFile,
    openFileDialog,
    openWithSystem,
    pathExists,
    saveAsNewDocument,
    saveFile,
    unwatchFile,
  } from "$lib/tauri/files";
  import { showToast } from "$lib/stores/toast";
  import { basename } from "$lib/utils/path";
  import { canSaveTab, needsSaveAs } from "$lib/utils/tab-save";
  import { promptOverwrite, promptUnsaved } from "$lib/utils/unsaved-prompt";
  import { settings, getContentMaxWidth, stepFontSize, DEFAULT_FONT_SIZE } from "$lib/stores/settings";
  import { translationSettings } from "$lib/stores/translation";
  import { runTranslation } from "$lib/translation/runTranslation";
  import {
    buildTargetPath,
    isValidBaseUrl,
    isValidSuffix,
    splitFrontmatter,
  } from "$lib/utils/translation";
  import { initFileWatcher, stopFileWatcher } from "$lib/tauri/watcher";
  import { restoreSession } from "$lib/tauri/session";
  import { attachSplitSync, type SplitSync } from "$lib/utils/split-sync";
  import { toggleTheme } from "$lib/stores/theme";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import { tocVisible, tocEntries } from "$lib/stores/toc";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import SpeechBar from "$lib/components/SpeechBar.svelte";
  import MarkdownRenderer from "$lib/components/MarkdownRenderer.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import TableOfContents from "$lib/components/TableOfContents.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import TabDragGhost from "$lib/components/TabDragGhost.svelte";
  import SearchOverlay from "$lib/components/SearchOverlay.svelte";
  import PasteModal from "$lib/components/PasteModal.svelte";
  import OpenDialog from "$lib/components/OpenDialog.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import TranslationSettings from "$lib/components/TranslationSettings.svelte";
  import ShortcutSettings from "$lib/components/ShortcutSettings.svelte";
  import GlossarySettings from "$lib/components/GlossarySettings.svelte";
  import GraderSettings from "$lib/components/GraderSettings.svelte";
  import ScorePanel from "$lib/components/ScorePanel.svelte";
  import LanguageDialog from "$lib/components/LanguageDialog.svelte";
  import AboutDialog from "$lib/components/AboutDialog.svelte";
  import CustomPromptModal from "$lib/components/CustomPromptModal.svelte";
  import { assembleUrlByIds, consumePendingSelection } from "$lib/stores/aiLookup";
  import FrontmatterBar from "$lib/components/FrontmatterBar.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import ProgressBar from "$lib/components/ProgressBar.svelte";
  import ScrollToTop from "$lib/components/ScrollToTop.svelte";
  import ImageLightbox from "$lib/components/ImageLightbox.svelte";
  import UpdateToast from "$lib/components/UpdateToast.svelte";
  import Toast from "$lib/components/Toast.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import PresentationView from "$lib/components/PresentationView.svelte";
  import { updateScrollPercent } from "$lib/stores/recents";
  import { checkForUpdates, updateAvailable, updateDismissed, checkInFlight } from "$lib/stores/updater";
  import { get } from "svelte/store";
  import { t, translate, hasChosenLocale } from "$lib/i18n";
  import { getCurrentSourceLine, scrollToSourceLine, type ViewMode } from "$lib/utils/scroll-sync";
  import { gutterHtml, gutterWidth, lineCount } from "$lib/utils/line-gutter";
  import { createWheelZoom } from "$lib/utils/wheel-zoom";
  import { chromeTopFor, chromeTop, sideTabsWidth } from "$lib/utils/layout";
  import { focusedPane, rightPaneOpen } from "$lib/stores/panes";
  import {
    concealedTabs,
    pruneConcealed,
    toggleConcealed,
  } from "$lib/stores/concealedTabs";
  import { A4_HEIGHT, A4_WIDTH, SIDE_COLUMN_WIDTH, type PageLayout } from "$lib/utils/page";
  import { fitWindowToPage } from "$lib/tauri/page-window";
  import { saveProgress, getProgress } from "$lib/stores/readingProgress";
  import { shortcuts } from "$lib/stores/shortcuts";
  import { matchesShortcut } from "$lib/utils/shortcut";
  import { toggleSpeech } from "$lib/tts/speech";
  import { glossaryMode } from "$lib/stores/glossaryMode";
  import { glossary } from "$lib/glossary/action";
  import { sentenceMode } from "$lib/stores/sentenceMode";
  import { sentence as sentenceAction } from "$lib/glossary/sentence";
  import { isEnglishDocument } from "$lib/utils/glossary";
  import { parasMode } from "$lib/stores/parasMode";
  import { paras as parasAction } from "$lib/paras/action";
  import {
    getParasDocument,
    getParasSession,
    parasDocuments,
    type ParasState,
  } from "$lib/paras/store";
  import { graderSettings, isGraderConfigured } from "$lib/stores/graderSettings";
  import {
    buildScoreMessages,
    parseScoreResponse,
    type ScoreParagraphInput,
    type ScoreRow,
  } from "$lib/utils/parasScore";

  let rendererReady = $state(false);
  let searchVisible = $state(false);
  let pasteVisible = $state(false);
  let pasteDefaultMode = $state<"paste" | "url">("paste");
  let openVisible = $state(false);
  let settingsVisible = $state(false);
  let translationSettingsVisible = $state(false);
  let shortcutSettingsVisible = $state(false);
  let glossarySettingsVisible = $state(false);
  let graderSettingsVisible = $state(false);
  let scorePanelVisible = $state(false);
  let scoring = $state(false);
  let scoreRows = $state<ScoreRow[]>([]);
  let scoreError = $state("");
  let scoreRaw = $state("");
  let scoreDegraded = $state(false);
  let parasCardOpen = $state(false);
  let parasState = $state<ParasState>({ items: {}, drafts: {} });
  let translating = $state(false);
  let translatingDirection = $state<"cn" | "en" | null>(null);
  let translatingProgress = $state<number | null>(null);
  let languageVisible = $state(false);
  let aboutVisible = $state(false);
  let customPromptVisible = $state(false);
  let customPromptSelection = $state("");
  let zenMode = $state(false);
  let rawMode = $state(false);
  let presenting = $state(false);
  // Split mode (#19): editor + live preview side by side. Both Split and Edit
  // are "editing" states (activeTab.isEditing true); splitMode just adds the
  // preview pane, so save / dirty / editContent all keep working unchanged.
  let splitMode = $state(false);
  let splitPreviewHtml = $state("");
  let splitPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let contentMaxWidth = $derived(getContentMaxWidth($settings));

  // Raw-view line numbers (#110). Same gutter treatment as the editor, driven by
  // the same `showLineNumbers` setting so the two views agree.
  let rawGutterOn = $derived($settings.showLineNumbers);
  let rawGutterWidth = $derived(gutterWidth(lineCount($docStore.content)));
  let rawGutterHtml = $derived(rawGutterOn ? gutterHtml($docStore.content) : "");

  // Lightbox state
  let lightboxVisible = $state(false);
  let lightboxImages = $state<string[]>([]);
  let lightboxIndex = $state(0);

  // Aggregated flag for any modal/overlay being visible. The close-on-ESC gate
  // and any future "is the user mid-interaction?" check should read this so a
  // new modal can't silently miss the gate by being added to state but not the
  // ESC handler. Each modal's own ESC handler also calls stopPropagation(); the
  // two together cover both focus-inside and focus-outside-modal cases.
  let anyModalVisible = $derived(
    searchVisible || pasteVisible || openVisible || settingsVisible || translationSettingsVisible || shortcutSettingsVisible || glossarySettingsVisible || graderSettingsVisible || scorePanelVisible || aboutVisible || customPromptVisible || lightboxVisible || languageVisible || $parasMode || parasCardOpen
  );

  // Reading progress: debounced scroll save + restore guard
  let isRestoring = false;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function handleScrollForProgress() {
    if (isRestoring) return;
    const tab = tabStore.getActiveTab();
    if (!tab || tab.isEditing) return;
    if (tab.filePath.startsWith("paste://")) return;

    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      // Tiny-file edge case: skip save if document fits in viewport
      if (document.documentElement.scrollHeight <= window.innerHeight) return;
      const line = getCurrentSourceLine("viewer");
      saveProgress(tab.filePath, line);
    }, 500);
  }

  function saveProgressNow() {
    clearTimeout(scrollSaveTimer);
    const tab = tabStore.getActiveTab();
    if (!tab || tab.isEditing) return;
    if (tab.filePath.startsWith("paste://")) return;
    // Tiny-file edge case: skip save if document fits in viewport
    if (document.documentElement.scrollHeight <= window.innerHeight) return;
    const line = getCurrentSourceLine("viewer");
    saveProgress(tab.filePath, line);
  }

  function handleVisibilityChange() {
    if (document.hidden) saveProgressNow();
  }

  function restoreProgress(filePath: string) {
    const savedLine = getProgress(filePath);
    if (!savedLine || savedLine <= 1) return;

    isRestoring = true;
    clearTimeout(restoreTimer);

    tick().then(() => {
      requestAnimationFrame(() => {
        const article = document.querySelector("article.prose");
        if (!article) { isRestoring = false; return; }

        const elements = Array.from(article.querySelectorAll<HTMLElement>("[data-source-line]"));
        if (elements.length === 0) { isRestoring = false; return; }

        // Find the saved line if it still exists, else fall back to the last
        // element (handles file-shrunk case where saved line no longer exists)
        let target: HTMLElement | null = null;
        for (const el of elements) {
          const elLine = parseInt(el.getAttribute("data-source-line") || "0", 10);
          if (elLine >= savedLine) { target = el; break; }
        }
        if (!target) target = elements[elements.length - 1];

        // Tiny-file edge case: don't restore if document fits in viewport
        const docHeight = document.documentElement.scrollHeight;
        if (docHeight <= window.innerHeight) { isRestoring = false; return; }

        target.scrollIntoView({ behavior: "smooth", block: "start" });

        // Clear isRestoring on scrollend (preferred) with 1s timeout fallback
        // for WebViews that don't support the scrollend event
        const clearRestoring = () => {
          clearTimeout(restoreTimer);
          window.removeEventListener("scrollend", clearRestoring);
          isRestoring = false;
        };
        window.addEventListener("scrollend", clearRestoring, { once: true });
        restoreTimer = setTimeout(clearRestoring, 1000);
      });
    });
  }

  const { tabs, activeTabId, activeIds } = tabStore;

  let activeTab = $derived<Tab | null>($tabs.find((t) => t.id === $activeTabId) ?? null);
  // Each column reads its own active tab. The left column can not follow
  // `activeTabId`, because that is whichever column has focus: with the right
  // column focused it would show the right column's document here instead.
  let leftTab = $derived<Tab | null>($tabs.find((t) => t.id === $activeIds.left) ?? null);
  let rightTab = $derived<Tab | null>($tabs.find((t) => t.id === $activeIds.right) ?? null);
  let focusedLeft = $derived($focusedPane === "left");
  // The editor always belongs to the left column (see the Editor blocks below),
  // but `activeTab` follows whichever column has focus. With the right column
  // focused, acting on `activeTab` hit a read-only document while the left one
  // was being edited — so Save and the mode buttons did nothing visible. Save
  // and view switches therefore target the tab actually open in the editor.
  let editorTab = $derived<Tab | null>(leftTab?.isEditing ? leftTab : activeTab);
  let rightOpen = $derived($rightPaneOpen);
  // Column concealment ("左"/"右"): each tab remembers its own cover state, so
  // switching to another document and back keeps the previous state. It is
  // only meaningful while both reading columns are on screen.
  let canConceal = $derived(
    rightOpen
      && !zenMode
      && !presenting
      && !!leftTab
      && !!rightTab
      && !leftTab.isEditing,
  );
  let leftConcealed = $derived(!!leftTab && $concealedTabs.has(leftTab.id));
  let rightConcealed = $derived(!!rightTab && $concealedTabs.has(rightTab.id));
  // The shared ToC follows the focused column; hide it when that column is
  // covered, or its headings would leak the text the user wants to recall.
  let tocConcealed = $derived(
    canConceal && ((focusedLeft && leftConcealed) || (!focusedLeft && rightConcealed)),
  );
  let canEditActive = $derived(
    !!editorTab?.filePath
    && !editorTab.filePath.startsWith("paste://")
    && !editorTab.filePath.startsWith("url://")
  );
  // The left column's own states: the editor, the raw view and split belong to
  // it, and the right column is the read-only one.
  let currentMode = $derived<ViewMode>(
    leftTab?.isEditing ? "editor" : rawMode ? "raw" : "viewer"
  );
  // Which segment of the View/Split/Edit control is active.
  let activeEditMode = $derived<"view" | "split" | "edit">(
    leftTab?.isEditing ? (splitMode ? "split" : "edit") : "view"
  );

  // Reading ("词") mode: word glosses only make sense in the dual reading
  // layout (two rendered columns, no source) and only for English content.
  let glossLayoutOk = $derived(rightOpen && !zenMode && !presenting && !leftTab?.isEditing && !rawMode);
  let glossLanguageOk = $derived(!!activeTab && isEnglishDocument(activeTab.content));
  let canGloss = $derived(glossLayoutOk && glossLanguageOk);
  let leftIsEnglish = $derived(!!leftTab && isEnglishDocument(leftTab.content));
  let rightIsEnglish = $derived(!!rightTab && isEnglishDocument(rightTab.content));
  let glossTitle = $derived(
    !glossLayoutOk
      ? $t("toolbar.glossDisabledMode")
      : !glossLanguageOk
        ? $t("toolbar.glossDisabledLang")
        : $glossaryMode
          ? $t("toolbar.glossOff")
          : $t("toolbar.glossOn"),
  );

  // Sentence ("句") mode is 词 one granularity up, so it shares the same gates
  // and is mutually exclusive with both other reading modes.
  let canSentence = $derived(canGloss);
  let sentenceTitle = $derived(
    !glossLayoutOk
      ? $t("toolbar.sentenceDisabledMode")
      : !glossLanguageOk
        ? $t("toolbar.sentenceDisabledLang")
        : $sentenceMode
          ? $t("toolbar.sentenceOn")
          : $t("toolbar.sentenceOff"),
  );

  // Paragraph ("段") mode reuses the same gates as 词: the two only make sense
  // in the dual reading layout with an English article, and they are mutually
  // exclusive because both paint highlights over the same column.
  let canParas = $derived(canGloss);
  let canScore = $derived($parasMode && canGloss);
  let activeParasSession = $derived(
    activeTab ? getParasSession(activeTab.id, activeTab.filePath) : null,
  );
  let parasStats = $derived.by(() => {
    const entries = activeTab ? ($parasDocuments[activeTab.id]?.entries ?? []) : [];
    let translated = 0;
    let skipped = 0;
    for (const entry of entries) {
      const item = parasState.items[entry.index];
      if (!item) continue;
      if (item.status === "skipped") skipped++;
      else if (item.text.trim().length > 0) translated++;
    }
    return { total: entries.length, translated, skipped };
  });
  let parasTitle = $derived(
    !glossLayoutOk
      ? $t("toolbar.parasDisabledMode")
      : !glossLanguageOk
        ? $t("toolbar.parasDisabledLang")
        : $parasMode
          ? `${$t("toolbar.parasOn")}${
              parasStats.total > 0
                ? ` · ${$t("toolbar.parasProgress", {
                    translated: parasStats.translated,
                    total: parasStats.total,
                    skipped: parasStats.skipped,
                  })}`
                : ""
            }`
          : $t("toolbar.parasOff"),
  );
  let scoreTitle = $derived(
    !glossLayoutOk
      ? $t("toolbar.parasDisabledMode")
      : !glossLanguageOk
        ? $t("toolbar.parasDisabledLang")
        : !$parasMode
          ? $t("toolbar.scoreNeedsParas")
          : scoring
            ? $t("toolbar.grading")
            : $t("toolbar.scoreTitle"),
  );

  // Mirror the active document's paragraph session into component state so
  // the toolbar count and the grader always see the same items.
  $effect(() => {
    const session = activeParasSession;
    if (!session) {
      parasState = { items: {}, drafts: {} };
      return;
    }
    return session.state.subscribe((value) => {
      parasState = value;
    });
  });

  // Publish the ToC width (#108) as a CSS variable so the fixed sidebar and the
  // document's left padding always agree on one number. It lives here rather
  // than in TableOfContents because that component unmounts in zen and edit
  // modes, which would leave the variable stale for anything still reading it.
  $effect(() => {
    document.documentElement.style.setProperty("--toc-w", `${$settings.tocWidth}px`);
  });

  // Same for the side tabs panel, and the height of the chrome above the
  // document, which loses the tab row when the tabs move to the side (see
  // utils/layout.ts). Zen mode hides the tabs, so it takes the panel away too.
  $effect(() => {
    const width = zenMode ? 0 : sideTabsWidth($settings);
    const root = document.documentElement;
    root.style.setProperty("--tabs-w", `${width}px`);
    root.style.setProperty("--chrome-top", `${chromeTopFor(width)}px`);
  });

  // The right column's width, published so the tab rows, the status bar, the
  // editor and the left column all agree on where it begins.
  $effect(() => {
    const width = rightOpen && !presenting && !zenMode ? SIDE_COLUMN_WIDTH : 0;
    document.documentElement.style.setProperty("--side-w", `${width}px`);
  });

  // A closed tab can never be shown again, so drop its cover state. The
  // `some` guard keeps the store update out of an effect loop.
  $effect(() => {
    const live = new Set($tabs.map((tab) => tab.id));
    if ([...$concealedTabs].some((id) => !live.has(id))) pruneConcealed(live);
  });

  // One A4 sheet per column, every launch. Split and Dual are the two layouts
  // that need two columns' worth of window; nothing else changes the window.
  function fitToPage(layout: PageLayout, center: boolean) {
    const s = get(settings);
    const tabs = zenMode ? 0 : sideTabsWidth(s);
    const toc = layout === "single" && !zenMode && get(tocVisible) && get(tocEntries).length > 0 ? s.tocWidth : 0;
    fitWindowToPage({ layout, sideTabsWidth: tabs, tocWidth: toc, chromeTop: chromeTopFor(tabs) }, center);
  }

  // The fit only re-runs when the layout changes. Guarded on that alone: a
  // keystroke replaces the tab object and would otherwise fire here.
  let fittedLayout: PageLayout = "single";
  $effect(() => {
    const dualOn = rightOpen && !presenting && !zenMode;
    const splitOn = splitMode && leftTab?.isEditing;
    const layout: PageLayout = dualOn ? "dual" : splitOn ? "split" : "single";
    if (layout === fittedLayout) return;
    fittedLayout = layout;
    fitToPage(layout, false);
  });

  // Live-render the editor content into the split preview pane, debounced so
  // fast typing stays smooth. ponytail: full re-render per debounce tick; fine
  // for typical docs — add incremental rendering only if a huge file lags.
  $effect(() => {
    if (!splitMode || !leftTab?.isEditing) return;
    const content = leftTab.editContent;
    const baseDir = getBaseDir(leftTab.filePath);
    clearTimeout(splitPreviewTimer);
    splitPreviewTimer = setTimeout(() => {
      const result = renderFull(content, baseDir);
      allowAssets(result.assetPaths, leftTab.filePath);
      splitPreviewHtml = result.html;
      // The re-render replaced the preview's blocks; put it back where the
      // editor is so typing never leaves the two panes on different sections.
      tick().then(() => splitSync?.syncFromEditor());
    }, 120);
    return () => clearTimeout(splitPreviewTimer);
  });

  // Split-mode scroll sync (#74): editor and preview follow each other. Keyed
  // on the mode string and the tab id, not the tab object, so a keystroke
  // (which replaces the tab object) does not re-attach the listeners, but a
  // tab switch does: each tab gets its own Editor, hence a new textarea (#129).
  // Attached after tick so both panes exist; the first sync lands the preview
  // where the editor already is.
  let splitSync: SplitSync | null = null;
  $effect(() => {
    if (activeEditMode !== "split") return;
    void $activeIds.left;
    let gone = false;
    tick().then(() => {
      if (gone) return;
      const ta = document.querySelector<HTMLTextAreaElement>("textarea.editor");
      const preview = document.querySelector<HTMLElement>("main.split-preview");
      if (!ta || !preview) return;
      splitSync = attachSplitSync(ta, preview);
      splitSync.syncFromEditor();
    });
    return () => {
      gone = true;
      splitSync?.dispose();
      splitSync = null;
    };
  });

  // Marp presentation (#44). `presenting` is a page-level view mode (like rawMode);
  // it's only meaningful when the active doc is a Marp deck.
  let activeIsMarp = $derived(isMarpDoc($docStore.frontmatter));
  let activePaginate = $derived(
    $docStore.frontmatter?.paginate === true || $docStore.frontmatter?.paginate === "true"
  );

  function togglePresent() {
    presenting = !presenting;
    if (presenting) {
      // Entering the slideshow supersedes raw/edit/split.
      rawMode = false;
      splitMode = false;
      if (editorTab?.isEditing) tabStore.setEditing(editorTab.id, false);
    }
  }

  /**
   * Switch view mode while preserving the source-line position so the user
   * stays anchored at the same place in the document.
   */
  function switchMode(target: ViewMode) {
    // The editor belongs to the left column, so the mode switch must act on
    // that tab — `activeTab` may be the read-only right column's document.
    const tab = editorTab;
    if (!tab || target === currentMode) return;
    if (target === "editor" && !canEditActive) return;

    // An explicit mode switch (raw/edit) leaves the slideshow (#44).
    presenting = false;

    // Close the find overlay on any mode change so a search started against one
    // target (viewer/raw/editor) can't leave a stale match count or highlights
    // behind when the on-screen target changes.
    searchVisible = false;

    const line = getCurrentSourceLine(currentMode);

    // Apply state changes for the target mode
    if (target === "editor") {
      tabStore.setEditing(tab.id, true);
    } else {
      // Exiting edit mode: re-render `editContent` (in-memory) so the viewer
      // shows the latest unsaved changes immediately. The dirty indicator
      // continues to mark that the changes aren't on disk yet.
      if (tab.isEditing && tab.dirty) {
        const baseDir = getBaseDir(tab.filePath);
        const result = renderFull(tab.editContent, baseDir);
        // Fire-and-forget: referenced images were almost always allowed at open;
        // a brand-new external image typed mid-edit self-heals on the next
        // render/reload. Not worth making this sync path async (#31).
        allowAssets(result.assetPaths, tab.filePath);
        // Update the rendered HTML in the docStore so the viewer reflects
        // the unsaved edits. We do NOT call tabStore.updateTabContent or
        // markSaved — the source on disk is unchanged, dirty stays true.
        docStore.set({
          filePath: tab.filePath,
          fileName: tab.fileName,
          content: tab.content,                   // disk content (unchanged)
          renderedHtml: result.html,              // preview of unsaved edits
          frontmatter: result.frontmatter,
          wordCount: result.wordCount,
          loading: false,
          error: null,
        });
      }
      if (tab.isEditing) tabStore.setEditing(tab.id, false);
      rawMode = target === "raw";
      splitMode = false; // leaving editing always leaves split
    }

    // Scroll the destination after it renders. Two rAFs are needed for the
    // editor — the first lets Svelte mount the textarea, the second lets the
    // browser compute its scrollHeight before we set scrollTop.
    tick().then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToSourceLine(target, line));
      });
    });
  }

  /** Saves the tab. Returns false if nothing was written — a clean file with a
   *  location, a cancelled Save-As dialog, the on-disk version was kept, or the
   *  write failed. Callers that gate a destructive action on a save need that
   *  (#160). A new document is saved even when `dirty` is false: its first save
   *  only chooses a location, so it cannot be skipped (#63). */
  async function handleSave(tab: Tab): Promise<boolean> {
    const isNew = needsSaveAs(tab);
    if (!tab.dirty && !isNew) return true;
    try {
      let targetPath = tab.filePath;
      let targetName = tab.fileName;
      // An unsaved `new://` document has no location yet — prompt for one on
      // this first save, which rebinds the tab to the chosen real path (#63).
      if (isNew) {
        const saved = await saveAsNewDocument(tab.id, tab.editContent);
        if (!saved) return false; // cancelled — keep editing, Save stays available
        targetPath = saved;
        targetName = basename(saved);
      } else {
        if (tab.diskChanged) {
          // The file changed on disk while these edits were unsaved (#97).
          // Overwrite is the explicit answer; Escape and the close box cancel
          // the save and leave both versions intact (#160).
          const overwrite = await promptOverwrite(
            translate("page.diskChangedMsg", { name: tab.fileName }),
            translate("page.diskChangedTitle")
          );
          if (!overwrite) return false;
        }
        await saveFile(tab.filePath, tab.editContent);
      }
      const baseDir = getBaseDir(targetPath);
      const result = renderFull(tab.editContent, baseDir);
      await allowAssets(result.assetPaths, targetPath);
      tabStore.markSaved(tab.id);
      tabStore.updateTabContent(
        targetPath,
        tab.editContent,
        result.html,
        result.frontmatter,
        result.wordCount
      );
      // Sync docStore so the rendered view reflects the saved content immediately
      // when the user toggles out of edit mode (the tab-sync $effect only fires on
      // active-tab change, not on content updates of the same tab).
      docStore.set({
        filePath: targetPath,
        fileName: targetName,
        content: tab.editContent,
        renderedHtml: result.html,
        frontmatter: result.frontmatter,
        wordCount: result.wordCount,
        loading: false,
        error: null,
      });
      return true;
    } catch (err) {
      console.error("Save failed:", err);
      // A native alert() blocks the whole WebView on Tauri: when a save failed,
      // every button stopped responding. The in-app toast reports the reason
      // without freezing the window.
      showToast(translate("page.saveFailed", { err: String(err) }), 6000);
      return false;
    }
  }

  // One save at a time: a second click while the Save-As dialog was still open
  // used to open a second native dialog. The one left underneath keeps the
  // window modal, so every later click on the app did nothing.
  let saveInFlight = $state(false);

  async function saveFromToolbar(): Promise<void> {
    if (saveInFlight || !editorTab || !canSaveTab(editorTab)) return;
    saveInFlight = true;
    try {
      await handleSave(editorTab);
    } finally {
      saveInFlight = false;
    }
  }

  // 段, 句 and 词 are mutually exclusive: all three decorate the same article,
  // and turning one on clears the others' highlights, bubbles and click
  // interception.
  function handleToggleParas(): void {
    const next = !$parasMode;
    if (next) {
      glossaryMode.set(false);
      sentenceMode.set(false);
    }
    parasMode.set(next);
  }

  function handleToggleGloss(): void {
    const next = !$glossaryMode;
    if (next) {
      parasMode.set(false);
      sentenceMode.set(false);
    }
    glossaryMode.set(next);
  }

  function handleToggleSentence(): void {
    const next = !$sentenceMode;
    if (next) {
      parasMode.set(false);
      glossaryMode.set(false);
    }
    sentenceMode.set(next);
  }

  function errorText(err: unknown): string {
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /**
   * 对比提交: every processed paragraph goes out in one request. Skipped
   * paragraphs are sent explicitly so the model knows the user gave up on
   * them, and the answer is only shown as a reference — the user's text is
   * never overwritten.
   */
  async function handleScore(): Promise<void> {
    if (scoring) return;
    if (!$parasMode) {
      showToast(translate("toolbar.scoreNeedsParas"));
      return;
    }
    const settings = get(graderSettings);
    if (!isGraderConfigured(settings)) {
      showToast(translate("score.notConfigured"));
      return;
    }
    const tabId = activeTab?.id;
    if (!tabId) return;
    const doc = getParasDocument(tabId);
    if (!doc || doc.total === 0) {
      showToast(translate("score.noParagraphs"));
      return;
    }

    const inputs: ScoreParagraphInput[] = [];
    for (const entry of doc.entries) {
      const item = parasState.items[entry.index];
      if (!item) continue;
      if (item.status === "skipped") {
        inputs.push({
          index: entry.index,
          english: entry.text,
          chinese: "",
          status: "skipped",
          type: entry.kind,
        });
      } else if (item.text.trim().length > 0) {
        inputs.push({
          index: entry.index,
          english: entry.text,
          chinese: item.text,
          status: "translated",
          type: entry.kind,
        });
      }
    }
    if (!inputs.some((input) => input.status === "translated")) {
      showToast(translate("score.noTranslations"));
      return;
    }

    scoring = true;
    scorePanelVisible = true;
    scoreRows = [];
    scoreError = "";
    scoreRaw = "";
    scoreDegraded = false;
    try {
      const raw = await invoke<string>("grader_score", {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: buildScoreMessages(inputs),
      });
      const parsed = parseScoreResponse(raw);
      const byIndex = new Map(parsed.entries.map((entry) => [entry.index, entry]));
      scoreRows = inputs.map<ScoreRow>((input) => {
        const answer = byIndex.get(input.index);
        return {
          ...input,
          score: answer?.score ?? null,
          comment: answer?.comment ?? "",
          recommended: answer?.recommended ?? "",
          answered: !!answer,
        };
      });
      if (!parsed.ok) {
        scoreError = translate("score.unparsable");
        scoreDegraded = true;
        scoreRaw = raw;
      } else if (parsed.entries.length < inputs.length) {
        scoreDegraded = true;
        scoreRaw = raw;
      }
    } catch (err) {
      // Real error text from Rust, including the endpoint's own message.
      scoreError = translate("score.failed", { err: errorText(err) });
    } finally {
      scoring = false;
    }
  }


  /**
   * The toolbar's cn / en buttons. The active tab is translated into the
   * requested language, written next to the source file, and opened in a new
   * tab that streams the result as it arrives.
   */
  async function handleTranslate(direction: "cn" | "en"): Promise<void> {
    if (translating) return;
    const tab = tabStore.getActiveTab();
    if (!tab) return;

    const content = tab.isEditing ? tab.editContent : tab.content;
    if (!content.trim()) {
      showToast(translate("translation.emptyDocument"));
      return;
    }
    const { body } = splitFrontmatter(content);
    if (!body.trim()) {
      showToast(translate("translation.emptyDocument"));
      return;
    }

    // A translation needs a real file to derive the target name and directory
    // from. A pasted, URL or never-saved document is told to save a local copy
    // first; the translation does not start until it has a path.
    if (
      !tab.filePath ||
      tab.filePath.startsWith("new://") ||
      tab.filePath.startsWith("paste://") ||
      tab.filePath.startsWith("url://")
    ) {
      await promptSaveForTranslation();
      return;
    }

    const config = get(translationSettings);
    const cnSuffix = config.cnSuffix.trim();
    const enSuffix = config.enSuffix.trim();
    if (
      !isValidBaseUrl(config.baseUrl) ||
      !config.model.trim() ||
      !isValidSuffix(cnSuffix) ||
      !isValidSuffix(enSuffix)
    ) {
      showToast(translate("translation.invalidConfig"));
      translationSettingsVisible = true;
      return;
    }

    const suffix = direction === "cn" ? cnSuffix : enSuffix;
    const targetPath = buildTargetPath(tab.filePath, suffix);
    const targetName = basename(targetPath);

    translating = true;
    translatingDirection = direction;
    translatingProgress = 0;
    try {
      const outcome = await runTranslation({
        sourceTab: tab,
        sourceContent: content,
        targetPath,
        targetName,
        direction,
        settings: {
          ...config,
          baseUrl: config.baseUrl.trim(),
          model: config.model.trim(),
          cnSuffix,
          enSuffix,
        },
        // Checked only when the translation is complete: until then nothing
        // has been written, and a cancel keeps the finished translation.
        confirmOverwrite: async () => {
          if (!(await pathExists(targetPath))) return true;
          return promptOverwrite(
            translate("translation.overwriteMsg", { name: targetName }),
            translate("translation.overwriteTitle"),
          );
        },
        onProgress: (percent) => (translatingProgress = percent),
      });
      if (outcome === "kept") showToast(translate("translation.keptNotSaved"));
    } catch (err) {
      console.error("Translation failed:", err);
      showToast(translate("translation.failed", { err: String(err) }), 7000);
    } finally {
      translating = false;
      translatingDirection = null;
      translatingProgress = null;
    }
  }

  /** A tab without an on-disk markdown file cannot be translated: the target
   *  name and folder are derived from the source path. Tell the user to save a
   *  local copy first, and never start the translation from here. */
  async function promptSaveForTranslation(): Promise<void> {
    try {
      const { message: dialog } = await import("@tauri-apps/plugin-dialog");
      await dialog(translate("translation.unsavedMsgReadonly"), {
        title: translate("translation.unsavedTitle"),
        kind: "info",
      });
    } catch {
      showToast(translate("translation.unsavedMsgReadonly"));
    }
  }

  /**
   * Open a local file linked from the rendered markdown (issue #30). Resolves
   * the href against the current document's directory: markdown files open in a
   * new in-app tab, other files (PDF, images, …) open in the OS default app,
   * and a missing target surfaces a toast without disturbing the current tab.
   */
  async function handleLocalLink(href: string) {
    const tab = activeTab;
    // paste:// and url:// tabs have no real base dir to resolve against — keep
    // the prior external-opener behavior for their links.
    if (!tab || !tab.filePath || tab.filePath.startsWith("paste://") || tab.filePath.startsWith("url://") || tab.filePath.startsWith("new://")) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(href);
      } catch {}
      return;
    }

    // Strip a trailing #fragment / ?query — we open the file, not an in-file
    // anchor (cross-file anchor scroll is out of scope for now). A bare "#frag"
    // was already handled as in-page navigation in the renderer.
    let target = href.replace(/[?#].*$/, "");
    // file: URLs arrive here (they're local) — reduce to a plain path.
    target = target.replace(/^file:\/\//i, "");
    if (!target) return;

    const resolved = resolveLocalPath(target, getBaseDir(tab.filePath));
    const name = basename(resolved);

    if (!(await pathExists(resolved))) {
      showToast(translate("page.cantFind", { name }));
      return;
    }

    if (/\.(md|markdown)$/i.test(resolved)) {
      await openFile(resolved);
      return;
    }

    // Security: never hand executable/script types to the OS opener. A clicked
    // link with deceptive text could otherwise launch a pre-existing payload in
    // one click. The capability independently permits only PDFs and common
    // raster images; keep this denylist as defense-in-depth.
    if (isExecutablePath(resolved)) {
      showToast(translate("page.wontOpenExecutable", { name }));
      return;
    }

    try {
      await openWithSystem(resolved);
    } catch {
      showToast(translate("page.couldntOpen", { name }));
    }
  }

  // Extensions that can run code when opened with the OS default handler.
  const EXECUTABLE_EXTENSIONS = new Set([
    // macOS / shell / scripting
    "app", "command", "sh", "bash", "zsh", "scpt", "applescript",
    "terminal", "workflow", "action", "osascript",
    // Windows
    "exe", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe", "js", "jse",
    "wsf", "msi", "msp", "cpl", "lnk", "reg", "hta", "pif",
    // cross-platform
    "jar",
  ]);

  function isExecutablePath(path: string): boolean {
    const name = path.split(/[\\/]/).pop() || "";
    const dot = name.lastIndexOf(".");
    if (dot < 0) return false;
    return EXECUTABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
  }

  // View / Split / Edit segmented control (#19). Split & Edit are both editing
  // states; splitMode is the only difference. Routed through switchMode so the
  // source-line position is preserved across the change.
  function setMode(target: "view" | "split" | "dual" | "edit") {
    const tab = editorTab;
    if (!tab) return;
    if (target === "dual") {
      // Dual is a toggle for the second column. Split goes off first: both
      // layouts claim two columns' worth of width.
      splitMode = false;
      if (rightOpen) {
        // Closing hands the right column's tabs back to the left column.
        tabStore.collapseRightPane();
      } else {
        rightPaneOpen.set(true);
        tabStore.moveTabToPane(tab.id, "right");
      }
      return;
    }
    if (target === "view") {
      // View is a mode of the left column, not a way out of the dual layout.
      // Collapsing the right column here removed the second drop target for
      // tab drags and swapped the active tab *before* switchMode ran (which
      // then saw `target === currentMode` and returned), so the button looked
      // dead. The Dual segment owns opening and closing the second column now.
      splitMode = false;
      switchMode(rawMode ? "raw" : "viewer");
      return;
    }
    if (!canEditActive) return;
    if (target === "edit") {
      splitMode = false;
      switchMode("editor");
    } else {
      switchMode("editor");
      splitMode = true;
    }
  }

  function handleEditToggle() {
    if (!canEditActive || !editorTab) return;
    // Cmd+E toggles full Edit against View (never Split).
    setMode(editorTab.isEditing ? "view" : "edit");
  }

  function handleRawToggle() {
    if (editorTab?.isEditing) return;
    switchMode(rawMode ? "viewer" : "raw");
  }

  function toggleLeftConceal(): void {
    if (!canConceal) return;
    toggleConcealed(leftTab?.id);
  }

  function toggleRightConceal(): void {
    if (!canConceal) return;
    toggleConcealed(rightTab?.id);
  }

  async function handleCloseTab(id: string): Promise<boolean> {
    const t = $tabs.find((x) => x.id === id);
    if (!t) return false;
    // Native dialog via the plugin — window.confirm() is a no-op in the Tauri
    // WKWebView (silently returns false), which made this guard dead and closed
    // dirty tabs without warning.
    if (t.dirty) {
      // Three answers, so neither reflex is destructive: Return saves, Escape
      // cancels, and Discard has to be clicked (#160). Anything unexpected is
      // treated as Cancel — see `promptUnsaved`.
      const choice = await promptUnsaved(
        translate("page.unsavedChangesOne", { name: t.fileName }),
        translate("page.unsavedChangesTitle")
      );
      if (choice === "cancel") return false;
      if (choice === "save") {
        if (!(await handleSave(t))) return false; // save cancelled or failed
      }
    }
    // Flush reading progress before closing — catches the case where user
    // scrolls and closes within the 500ms debounce window
    if (t.id === $activeTabId) {
      saveProgressNow();
    }
    // Re-read the tab: saving a `new://` document rebinds it to the real path
    // it was just written to, and `t` is a snapshot from before that. Unwatching
    // the stale `new://` path would leave the real file watched after the tab
    // closed.
    const watchedPath = $tabs.find((x) => x.id === id)?.filePath ?? t.filePath;
    tabStore.closeTab(id);
    unwatchFile(watchedPath);
    return true;
  }

  // Close the active tab, from either Cmd+W route (the File > Close Tab menu
  // item, or the keydown fallback). The guard makes a double-fire harmless: if
  // a platform delivers both the menu accelerator and the keydown for one press,
  // the second call returns instead of closing a second tab. handleCloseTab
  // always awaits at least a microtask, so the flag is set before it can re-enter.
  // Print the rendered document via the native dialog (#89), from File > Print,
  // Cmd/Ctrl+P, or the toolbar. Same conditions as the toolbar button: there
  // must be a rendered document and it must not be in the editor. The flag
  // makes a double-fire harmless if a platform delivers both the menu
  // accelerator and the keydown for one press — WebView2 also binds Ctrl+P
  // itself, and two print dialogs is worse than none.
  let printInFlight = false;
  function printDocument() {
    if (printInFlight) return;
    if (!$docStore.renderedHtml || activeTab?.isEditing) return;
    printInFlight = true;
    try {
      window.print();
    } finally {
      // window.print() is modal on every platform we ship, so by the time it
      // returns the dialog has been dismissed; a short hold covers the
      // menu+keydown pair arriving back to back.
      setTimeout(() => { printInFlight = false; }, 300);
    }
  }

  let closeInFlight = false;
  async function closeActiveTab() {
    if (closeInFlight) return;
    closeInFlight = true;
    try {
      const t = tabStore.getActiveTab();
      if (t) await handleCloseTab(t.id);
    } finally {
      closeInFlight = false;
    }
  }

  // Close-on-ESC: close the active file tab, and quit the app if it was the last
  // one (on macOS closing the window alone leaves the app in the dock). Async
  // because the dirty-confirm dialog is — a cancelled discard must not quit.
  async function closeActiveTabOnEscape() {
    const tabsBeforeClose = $tabs.length;
    if (activeTab && activeTab.id !== HOME_TAB_ID) {
      const closed = await handleCloseTab(activeTab.id);
      if (closed && tabsBeforeClose === 1) {
        invoke("quit_app").catch(() => {});
      }
    } else if (tabsBeforeClose === 0) {
      // Active is home tab and no file tabs are open → quit
      invoke("quit_app").catch(() => {});
    }
    // Else: home tab is active with file tabs in background — do nothing.
  }

  onMount(() => {
    initRenderer();
    rendererReady = true;

    // A4 on every launch, whatever the last session left behind: the document
    // width becomes the sheet and the window is sized to show all of it.
    settings.update((s) => ({ ...s, maxWidth: A4_WIDTH, widthMode: "comfortable" }));
    fitToPage("single", true);

    // First run: ask for a language. The picker highlights the OS-detected
    // one (English when the OS language isn't supported); choosing or
    // dismissing stores a choice, so it only ever appears once.
    if (!hasChosenLocale()) languageVisible = true;

    // Expose functions for native menu and OS file-open handlers
    (window as any).__mdhero_open_file = () => { openVisible = true; };
    (window as any).__mdhero_open_path = (path: string) => {
      if (path && rendererReady) {
        openFile(path);
      }
    };
    (window as any).__mdhero_paste = () => {
      pasteDefaultMode = "paste";
      pasteVisible = true;
    };
    (window as any).__mdhero_toggle_theme = () => {
      toggleTheme();
    };
    (window as any).__mdhero_find = () => {
      searchVisible = !searchVisible;
    };
    // File > Close Tab (Cmd/Ctrl+W). The menu item declared this accelerator
    // but lib.rs had no branch for its id, so the event was dropped — and
    // because the native menu consumes the key, the keydown fallback never ran
    // either: the shortcut and the menu item were both dead.
    (window as any).__mdhero_close_tab = () => {
      void closeActiveTab();
    };
    (window as any).__mdhero_print = () => {
      printDocument();
    };
    (window as any).__mdhero_zen = () => {
      zenMode = !zenMode;
    };
    (window as any).__mdhero_about = () => {
      aboutVisible = true;
    };
    // App-quit guard (#54): the red-button (CloseRequested) and Cmd+Q / menu
    // Quit (custom "quit" menu item) both route here rather than terminating, so
    // quitting with unsaved edits gets the same confirm dialog as tab close.
    // One prompt covers all dirty tabs. On "Keep Editing" we stay; otherwise
    // (Discard, no dirty tabs, or dialog failure) we quit via quit_app — a hard
    // exit, so we never trap the user in an app that can't close.
    (window as any).__mdhero_quit = async () => {
      const dirty = $tabs.filter((t) => t.dirty);
      if (dirty.length > 0) {
        const msg =
          dirty.length === 1
            ? translate("page.unsavedChangesOne", { name: dirty[0].fileName })
            : translate("page.unsavedChangesMany", { count: dirty.length });
        const choice = await promptUnsaved(msg, translate("page.unsavedChangesTitle"));
        // Cancel, Escape, the close box and a dialog that fails all land here.
        // The old code quit on a dialog failure, which is the same data loss by
        // a different route (#160).
        if (choice === "cancel") return;
        if (choice === "save") {
          for (const t of dirty) {
            // An unsaved `new://` tab opens a Save-As dialog; cancelling that
            // one aborts the quit rather than dropping the document.
            if (!(await handleSave(t))) return;
          }
        }
      }
      saveProgressNow();
      invoke("quit_app").catch(() => {});
    };
    // 设置快捷键 menu item: open the shortcut settings panel.
    (window as any).__mdhero_shortcuts = () => {
      shortcutSettingsVisible = true;
    };
    (window as any).__mdhero_check_updates = async () => {
      if (get(checkInFlight)) return;
      // Reset dismissal so a manual check always re-surfaces an available update.
      updateDismissed.set(false);
      await checkForUpdates(true);
      // If still nothing, give the user explicit feedback — silence is confusing
      // when a menu item is the trigger.
      if (!get(updateAvailable)) {
        // Toast, not alert(): a native dialog blocks the WebView's IPC loop.
        showToast(translate("page.upToDate"));
      }
    };
    // Router for AI Lookup right-click menu items. lib.rs::setup forwards any
    // menu event ID starting with "aimenu:" through this hook. The current
    // selection was stashed in the aiLookup runtime helper at contextmenu
    // capture time — we consume it here so a stale selection can't leak into
    // a future menu open.
    (window as any).__mdhero_ai_lookup = async (menuId: string) => {
      const selection = consumePendingSelection();
      if (menuId === "aimenu:google") {
        if (!selection.trim()) return;
        const url = `https://www.google.com/search?q=${encodeURIComponent(selection)}`;
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
      }
      if (menuId === "aimenu:custom") {
        customPromptSelection = selection;
        customPromptVisible = true;
        return;
      }
      if (menuId.startsWith("aimenu:template:")) {
        // aimenu:template:{providerId}:{promptId}
        const rest = menuId.slice("aimenu:template:".length);
        const colon = rest.indexOf(":");
        if (colon < 0) return;
        const providerId = rest.slice(0, colon);
        const promptId = rest.slice(colon + 1);
        const url = assembleUrlByIds(providerId, promptId, selection);
        if (!url) return;
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
      }
      // aimenu:noop:* fires only from disabled items in theory — defensive ignore.
    };

    // Listen for keyboard shortcuts and scroll for reading progress
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("keyup", handleKeyup);
    // Not passive: the page must not scroll under a Ctrl + wheel zoom.
    window.addEventListener("wheel", handleWheel, { passive: false });
    // Safety net: if focus leaves while j/k is held, keyup may never fire — stop the loop.
    window.addEventListener("blur", stopScroll);
    window.addEventListener("scroll", handleScrollForProgress, { passive: true });
    window.addEventListener("beforeunload", saveProgressNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // One file-changed listener for the session (#97); which files are watched
    // follows the tabs (open / close / save-as), not the active document.
    void initFileWatcher();

    void (async () => {
      // Bring back last run's tabs first (#72), so a file opened via "Open
      // With" or the CLI below lands on top of them as the active tab.
      if ($settings.restoreTabsOnLaunch) {
        try {
          await restoreSession();
        } catch {}
      }

      // Check for files opened via "Open With" / double-click (buffered in Rust state)
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const openedFiles = await invoke<string[]>("get_opened_files");
        if (openedFiles.length > 0) {
          await openFile(openedFiles[0]);
        }
      } catch {}

      // Check for updates (non-blocking, skips in dev)
      checkForUpdates();

      // Check for CLI file argument
      try {
        const { getMatches } = await import("@tauri-apps/plugin-cli");
        const matches = await getMatches();
        if (matches.args?.file?.value) {
          await openFile(matches.args.file.value as string);
        }
      } catch {
        // CLI plugin may not be available in dev
      }
    })();

    return () => {
      stopFileWatcher();
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("keyup", handleKeyup);
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("blur", stopScroll);
      stopScroll();
      window.removeEventListener("scroll", handleScrollForProgress);
      window.removeEventListener("beforeunload", saveProgressNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  });

  let lastKey = "";
  let lastKeyTime = 0;

  // Continuous vim j/k scrolling. Instead of firing a per-press smooth animation
  // (which eases per 100px chunk and gets cancelled/restarted by OS key-repeat,
  // producing visible stutter), we drive a single requestAnimationFrame loop while
  // the key is held and stop it on keyup. This matches the native, continuous feel
  // of arrow-key/trackpad scrolling. The half-page (d/u) and gg/G jumps stay smooth.
  //
  // Velocity is time-based (px/sec, scaled by the frame delta) rather than a fixed
  // px-per-frame step, so the speed stays consistent regardless of display refresh
  // rate (60Hz vs 120Hz ProMotion) and roughly matches native arrow-key scrolling.
  const SCROLL_SPEED = 1000; // px per second
  let scrollRAF: number | null = null;
  let scrollDir = 0; // -1 = up, +1 = down, 0 = stopped
  let scrollLastTs = 0;
  const pressedScrollKeys = new Set<"j" | "k">();
  let activeScrollKey: "j" | "k" | null = null;

  function updateScrollDirection() {
    scrollDir = activeScrollKey === "j" ? 1 : activeScrollKey === "k" ? -1 : 0;
  }

  function startScroll(key: "j" | "k") {
    pressedScrollKeys.add(key);
    activeScrollKey = key;
    updateScrollDirection();
    if (scrollRAF !== null) return;
    scrollLastTs = 0;
    const step = (ts: number) => {
      if (scrollDir === 0) {
        scrollRAF = null;
        return;
      }
      // First frame establishes the baseline timestamp; no movement yet.
      const dt = scrollLastTs === 0 ? 0 : ts - scrollLastTs;
      scrollLastTs = ts;
      window.scrollBy(0, scrollDir * SCROLL_SPEED * (dt / 1000));
      scrollRAF = requestAnimationFrame(step);
    };
    scrollRAF = requestAnimationFrame(step);
  }

  function stopScroll() {
    pressedScrollKeys.clear();
    activeScrollKey = null;
    scrollDir = 0;
    scrollLastTs = 0;
    if (scrollRAF !== null) {
      cancelAnimationFrame(scrollRAF);
      scrollRAF = null;
    }
  }

  function releaseScrollKey(key: "j" | "k") {
    pressedScrollKeys.delete(key);
    if (activeScrollKey !== key) return;

    if (pressedScrollKeys.has("j")) {
      activeScrollKey = "j";
    } else if (pressedScrollKeys.has("k")) {
      activeScrollKey = "k";
    } else {
      activeScrollKey = null;
    }

    updateScrollDirection();
    if (scrollDir === 0) stopScroll();
  }

  function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
  }

  function jumpToHeading(direction: "prev" | "next") {
    const headings = document.querySelectorAll("article h1[id], article h2[id], article h3[id], article h4[id], article h5[id], article h6[id]");
    if (headings.length === 0) return;
    const offset = chromeTop() + 5;
    const scrollY = window.scrollY + offset;

    if (direction === "next") {
      for (const h of headings) {
        const top = (h as HTMLElement).offsetTop;
        if (top > scrollY + 5) {
          window.scrollTo({ top: top - offset, behavior: "smooth" });
          return;
        }
      }
    } else {
      const arr = Array.from(headings).reverse();
      for (const h of arr) {
        const top = (h as HTMLElement).offsetTop;
        if (top < scrollY - 5) {
          window.scrollTo({ top: top - offset, behavior: "smooth" });
          return;
        }
      }
    }
  }

  // Move the active tab by `delta` positions through the visible tab order,
  // wrapping at both ends. The cycling stays inside the column being worked in:
  // the other column keeps whatever it was showing.
  function cycleTab(delta: number) {
    const pane = get(focusedPane);
    const ids = tabStore.paneTabs(pane).map((t) => t.id);
    // Only the left column can go back to the recents screen.
    const order = pane === "left" ? [HOME_TAB_ID, ...ids] : ids;
    if (order.length <= 1) return;
    const current = order.indexOf($activeTabId ?? HOME_TAB_ID);
    const base = current === -1 ? 0 : current;
    const next = (base + delta + order.length) % order.length;
    const nextId = order[next];
    if (nextId === HOME_TAB_ID) {
      tabStore.goHome();
    } else {
      tabStore.switchTab(nextId);
    }
  }

  // Ctrl + mouse wheel zooms like Cmd/Ctrl+= and Cmd/Ctrl+-. Ctrl on every
  // platform, as in browsers; a touchpad pinch arrives the same way.
  const wheelZoomStep = createWheelZoom();

  function handleWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const step = wheelZoomStep(e);
    if (step !== 0) {
      settings.update((s) => ({ ...s, fontSize: stepFontSize(s.fontSize, step) }));
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // Play/pause reading (Settings → keyboard shortcuts). Global by design;
    // matchesShortcut already rejects key repeat and modifier combinations.
    if (matchesShortcut(e, $shortcuts.playPause)) {
      // Do not eat the key inside a text field: backquote is a markdown code
      // fence. The shortcut still fires there (the user accepted that trade-off).
      if (!isInputFocused()) e.preventDefault();
      // The paragraph editor types into a textarea; a shortcut press there
      // must not start or stop reading behind the card.
      if (!shortcutSettingsVisible && !parasCardOpen) toggleSpeech();
      return;
    }

    // Cmd+1-9 tab switching, inside the column being worked in.
    if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      const idx = parseInt(e.key) - 1;
      const rowTabs = tabStore.paneTabs(get(focusedPane));
      if (rowTabs[idx]) {
        tabStore.switchTab(rowTabs[idx].id);
      }
      return;
    }

    // macOS: Cmd+Shift+[ / Cmd+Shift+] cycle tabs (standard macOS convention).
    // Use e.code because Shift turns "["/"]" into "{"/"}" in e.key.
    if (
      e.metaKey
      && e.shiftKey
      && (e.code === "BracketLeft" || e.code === "BracketRight")
    ) {
      e.preventDefault();
      cycleTab(e.code === "BracketRight" ? 1 : -1);
      return;
    }

    // Windows/Linux: Ctrl+Tab / Ctrl+Shift+Tab (browser convention),
    // and Ctrl+PageDown / Ctrl+PageUp (VS Code convention, also in Chrome).
    if (e.ctrlKey && (e.key === "Tab" || e.code === "PageUp" || e.code === "PageDown")) {
      e.preventDefault();
      const forward = e.key === "Tab" ? !e.shiftKey : e.code === "PageDown";
      cycleTab(forward ? 1 : -1);
      return;
    }

    // Cmd+Plus / Cmd+= zoom in (works on both macOS and Windows)
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      settings.update((s) => ({ ...s, fontSize: stepFontSize(s.fontSize, 1) }));
      return;
    }

    // Cmd+Minus zoom out
    if ((e.metaKey || e.ctrlKey) && e.key === "-") {
      e.preventDefault();
      settings.update((s) => ({ ...s, fontSize: stepFontSize(s.fontSize, -1) }));
      return;
    }

    // Cmd+0 reset zoom
    if ((e.metaKey || e.ctrlKey) && e.key === "0") {
      e.preventDefault();
      settings.update((s) => ({ ...s, fontSize: DEFAULT_FONT_SIZE }));
      return;
    }

    // Cmd+E toggle edit mode
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "e") {
      e.preventDefault();
      handleEditToggle();
      return;
    }

    // Cmd+S saves the same document the button saves: the one open in the
    // editor, including a brand-new document that still needs a location.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "s") {
      e.preventDefault();
      void saveFromToolbar();
      return;
    }

    // Cmd+U raw toggle (disabled in edit mode)
    if ((e.metaKey || e.ctrlKey) && e.key === "u") {
      e.preventDefault();
      handleRawToggle();
      return;
    }

    // Cmd+T new document (blank tab, opens in the editor — #63)
    if ((e.metaKey || e.ctrlKey) && e.key === "t") {
      e.preventDefault();
      newDocument();
      return;
    }

    // Cmd+, open settings (macOS Preferences convention)
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      settingsVisible = !settingsVisible;
      return;
    }

    // Cmd+W close tab (with dirty confirm). Usually dead code: the File menu
    // binds the same accelerator and native menus consume the key before the
    // webview sees it. Kept as the fallback for any platform where it doesn't.
    if ((e.metaKey || e.ctrlKey) && e.key === "w") {
      e.preventDefault();
      void closeActiveTab();
      return;
    }
    // Cmd/Ctrl+P print (#89). Same story as Cmd+W: the File menu owns the
    // accelerator where native menus consume keys; this is the fallback.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "p") {
      e.preventDefault();
      printDocument();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
      e.preventDefault();
      zenMode = !zenMode;
      return;
    }

    // Escape — close panels, then optionally close-tab-on-ESC
    if (e.key === "Escape") {
      if (zenMode) { zenMode = false; return; }

      // Exit the Marp slideshow before any modal/close-tab handling (#44).
      if (presenting) { presenting = false; return; }

      // Modals/overlays consume ESC first. Inner handlers stopPropagation when focus
      // is inside them; this guard covers the focus-outside case (modal visible but
      // user clicked elsewhere) so we don't nuke the tab while a modal is still up.
      // Add new modals to `anyModalVisible` (see top of script) to keep this safe.
      if (anyModalVisible) return;

      // Close-on-ESC: opt-in setting. Ignore in edit mode and when an input is focused
      // (so users typing in search/paste/etc. don't accidentally trigger it).
      if ($settings.closeOnEscape && !activeTab?.isEditing && !isInputFocused()) {
        // handleCloseTab is async (native dirty-confirm dialog), so the
        // quit-on-last-tab decision runs in an async helper.
        closeActiveTabOnEscape();
      }
      return;
    }

    // Vim-style keys — only when no input is focused and not in edit mode
    if (isInputFocused() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (activeTab?.isEditing) return;
    if (!$docStore.renderedHtml) return;

    const now = Date.now();

    switch (e.key) {
      case "j":
        e.preventDefault();
        // Ignore OS key-repeat — the rAF loop drives continuous motion until keyup.
        if (e.repeat) break;
        startScroll("j");
        break;
      case "k":
        e.preventDefault();
        if (e.repeat) break;
        startScroll("k");
        break;
      case "d":
        // half page down
        e.preventDefault();
        window.scrollBy({ top: window.innerHeight / 2, behavior: "smooth" });
        break;
      case "u":
        // half page up
        e.preventDefault();
        window.scrollBy({ top: -window.innerHeight / 2, behavior: "smooth" });
        break;
      case "G":
        // Shift+G — go to bottom
        e.preventDefault();
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        break;
      case "g":
        // gg — go to top (double tap g within 500ms)
        if (lastKey === "g" && now - lastKeyTime < 500) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: "smooth" });
          lastKey = "";
          return;
        }
        break;
      case "/":
        e.preventDefault();
        searchVisible = true;
        break;
      case "n":
        // next search match (handled by SearchOverlay if visible)
        break;
      case "]":
        e.preventDefault();
        jumpToHeading("next");
        break;
      case "[":
        e.preventDefault();
        jumpToHeading("prev");
        break;
    }

    lastKey = e.key;
    lastKeyTime = now;
  }

  function handleKeyup(e: KeyboardEvent) {
    // Stop the continuous j/k scroll loop when the key is released.
    if (e.key === "j" || e.key === "k") releaseScrollKey(e.key);
  }

  // Sync tab switching with document store. The document store mirrors the LEFT
  // column: that is the column the window-level chrome belongs to (the status
  // bar, print, the scroll-based reading progress, the raw view). What the
  // keyboard acts on is `activeTab`, which follows whichever column has focus.
  let prevTabId: string | null = null;

  $effect(() => {
    const id = $activeIds.left;
    const allTabs = $tabs;

    // Skip if same tab
    if (id === prevTabId) return;

    // Save reading progress for the tab we're leaving.
    // At this point in the $effect, $activeTabId has changed but the DOM still
    // shows the previous tab's content (docStore.set happens below), so
    // getCurrentSourceLine reads the correct article elements. We flush the
    // debounce to ensure nothing is lost on rapid tab switches.
    if (prevTabId && prevTabId !== HOME_TAB_ID) {
      const prevTab = allTabs.find((t) => t.id === prevTabId);
      if (prevTab && !prevTab.isEditing && !prevTab.filePath.startsWith("paste://")) {
        clearTimeout(scrollSaveTimer);
        if (document.documentElement.scrollHeight > window.innerHeight) {
          const line = getCurrentSourceLine("viewer");
          saveProgress(prevTab.filePath, line);
        }
      }
    }

    prevTabId = id;

    if (!id || id === HOME_TAB_ID) {
      rawMode = false;
      presenting = false;
      splitMode = false;
      docStore.set({
        filePath: null,
        fileName: null,
        content: "",
        renderedHtml: "",
        frontmatter: null,
        wordCount: 0,
        loading: false,
        error: null,
      });
      tocVisible.set(false);
      tocEntries.set([]);
      getCurrentWindow().setTitle("MDHero").catch(() => {});
      return;
    }

    const tab = allTabs.find((t) => t.id === id);
    if (!tab) return;

    docStore.set({
      filePath: tab.filePath,
      fileName: tab.fileName,
      content: tab.content,
      renderedHtml: tab.renderedHtml,
      frontmatter: tab.frontmatter,
      wordCount: tab.wordCount,
      loading: false,
      error: null,
    });

    // Auto-present a Marp deck on activation when the setting is on and we're not
    // mid-edit (#44). Runs once per tab switch, so an explicit exit (Esc) sticks.
    presenting = isMarpDoc(tab.frontmatter) && get(settings).autoPresentMarp && !tab.isEditing;

    getCurrentWindow().setTitle(`${tab.fileName} — MDHero`).catch(() => {});

    const savedScroll = tab.scrollTop;
    tick().then(() => {
      requestAnimationFrame(() => {
        window.scrollTo(0, savedScroll);
        // Restore reading progress (smooth-scroll to saved source line)
        // Only if the tab is at scroll 0 (freshly opened or re-opened)
        if (savedScroll === 0) {
          restoreProgress(tab.filePath);
        }
      });
    });
  });

</script>

<div class="min-h-screen transition-colors page-root">
  {#if !zenMode}
    <ProgressBar />
    <Toolbar
      onOpen={() => (openVisible = true)}
      onPaste={() => { pasteDefaultMode = "paste"; pasteVisible = true; }}
      onUrl={() => { pasteDefaultMode = "url"; pasteVisible = true; }}
      {rawMode}
      onRawToggle={handleRawToggle}
      isEditing={editorTab?.isEditing ?? false}
      dirty={editorTab?.dirty ?? false}
      canSave={canSaveTab(editorTab) && !saveInFlight}
      canEdit={canEditActive}
      editMode={activeEditMode}
      dual={rightOpen}
      onSetMode={setMode}
      canConceal={canConceal}
      leftConcealed={leftConcealed}
      rightConcealed={rightConcealed}
      concealHeading={tocConcealed}
      onToggleConcealLeft={toggleLeftConceal}
      onToggleConcealRight={toggleRightConceal}
      onSave={saveFromToolbar}
      onOpenSettings={() => (settingsVisible = true)}
      canTranslate={!!activeTab}
      {translating}
      {translatingDirection}
      translateProgress={translatingProgress}
      onTranslate={handleTranslate}
      onOpenTranslationSettings={() => (translationSettingsVisible = true)}
      canSpeak={!!activeTab}
      canGloss={canGloss}
      glossActive={canGloss && $glossaryMode}
      {glossTitle}
      onToggleGloss={handleToggleGloss}
      onOpenGlossSettings={() => (glossarySettingsVisible = true)}
      canSentence={canSentence}
      sentenceActive={canSentence && $sentenceMode}
      {sentenceTitle}
      onToggleSentence={handleToggleSentence}
      canParas={canParas}
      parasActive={canParas && $parasMode}
      {parasTitle}
      parasTranslated={parasStats.translated}
      parasTotal={parasStats.total}
      onToggleParas={handleToggleParas}
      canScore={canScore}
      {scoring}
      {scoreTitle}
      onScore={handleScore}
      onOpenGraderSettings={() => (graderSettingsVisible = true)}
      canPresent={activeIsMarp}
      presenting={presenting}
      onTogglePresent={togglePresent}
    />
    <TabBar onCloseTab={handleCloseTab} pane="left" focused={focusedLeft} />
    {#if rightOpen}
      <!-- The second column has its own row of tabs. TabBar pins it over that
         column, and a tab dragged onto it moves between the two. -->
      <TabBar onCloseTab={handleCloseTab} pane="right" focused={!focusedLeft} />
    {/if}
  {/if}
  <TabDragGhost />
  <DropZone />
  {#if !zenMode && !activeTab?.isEditing && !tocConcealed}
    <TableOfContents />
  {/if}
  <SpeechBar />
  <SearchOverlay bind:visible={searchVisible} />
  <PasteModal bind:visible={pasteVisible} defaultMode={pasteDefaultMode} />
  <OpenDialog bind:visible={openVisible} />
  <SettingsDialog bind:visible={settingsVisible} />
  <TranslationSettings bind:visible={translationSettingsVisible} />
  <ShortcutSettings bind:visible={shortcutSettingsVisible} />
  <GlossarySettings bind:visible={glossarySettingsVisible} />
  <GraderSettings bind:visible={graderSettingsVisible} />
  <ScorePanel
    bind:visible={scorePanelVisible}
    loading={scoring}
    rows={scoreRows}
    error={scoreError}
    raw={scoreRaw}
    degraded={scoreDegraded}
    translated={parasStats.translated}
    total={parasStats.total}
    skipped={parasStats.skipped}
  />
  <LanguageDialog bind:visible={languageVisible} />
  <AboutDialog bind:visible={aboutVisible} />
  <CustomPromptModal bind:visible={customPromptVisible} selection={customPromptSelection} />

  <div class="doc-area">
  {#if !rendererReady}
    <div class="state-center">
      <p class="state-text pulse">{$t('page.loadingRenderer')}</p>
    </div>
  {:else if $docStore.loading}
    <div class="state-center">
      <p class="state-text pulse">{$t('page.openingFile')}</p>
    </div>
  {:else if $docStore.error}
    <div class="state-center">
      <div class="error-box">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p class="error-msg">{$docStore.error}</p>
      </div>
    </div>
  {:else if $docStore.filePath}
    <!-- Gate on filePath, not renderedHtml: an empty file renders to empty HTML,
         and gating on that dropped the user back to the home/recents view with no
         way to edit (#52). A real (even empty) file tab always shows here. -->
    {#if presenting && activeIsMarp}
      <PresentationView
        content={$docStore.content}
        baseDir={activeTab ? getBaseDir(activeTab.filePath) : ""}
        paginate={activePaginate}
        onExit={() => (presenting = false)}
        onLocalLink={handleLocalLink}
      />
    {:else if leftTab?.isEditing && splitMode}
      <!-- Split (#19): editor left, live preview right. Both panes are fixed
           half-width; the Editor's own fixed positioning takes the `split` prop
           to yield the left half. Keyed on the tab (#129): the Editor keeps a
           local copy of the text that it won't overwrite while focused, and a
           tab switch doesn't blur it, so a reused instance kept showing (and
           saving into the new tab) the previous tab's text. The editor always
           belongs to the left column, so it reads that column's tab. -->
      {#key leftTab.id}
        <Editor
          value={leftTab.editContent}
          onChange={(v) => tabStore.updateEditContent(leftTab!.id, v)}
          fontSize={$settings.fontSize}
          lineHeight={$settings.lineHeight}
          maxWidth={contentMaxWidth}
          showLineNumbers={$settings.showLineNumbers}
          syntaxHighlighting={$settings.syntaxHighlighting}
          split
        />
      {/key}
      <main class="split-preview" data-focused={focusedLeft || undefined}>
        <MarkdownRenderer
          html={splitPreviewHtml}
          onImageClick={(src, all, idx) => { lightboxImages = all; lightboxIndex = idx; lightboxVisible = true; }}
          onLocalLink={handleLocalLink}
        />
      </main>
    {:else if leftTab?.isEditing}
      <!-- One Editor per tab, as in Split above (#19/#129). -->
      {#key leftTab.id}
        <Editor
          value={leftTab.editContent}
          onChange={(v) => tabStore.updateEditContent(leftTab!.id, v)}
          fontSize={$settings.fontSize}
          lineHeight={$settings.lineHeight}
          maxWidth={contentMaxWidth}
          showLineNumbers={$settings.showLineNumbers}
          syntaxHighlighting={$settings.syntaxHighlighting}
        />
      {/key}
    {:else if rawMode}
      <main
        class="content-main"
        class:toc-spaced={$tocVisible && $tocEntries.length > 0}
        class:concealed={canConceal && leftConcealed}
        data-focused={focusedLeft || undefined}
      >
        <div
          class="raw-stack sheet"
          class:with-gutter={rawGutterOn}
          style="max-width: {contentMaxWidth}; min-height: {A4_HEIGHT}px; --gutter-w: {rawGutterWidth};"
        >
          {#if rawGutterOn}
            <!-- Transparent mirror wrapping identically to the <pre>; CSS
                 counters on each line block draw the numbers. Kept out of the
                 <pre> so `scroll-sync` still reads the source from its
                 textContent. -->
            <div
              class="raw-gutter"
              aria-hidden="true"
              style="font-size: {$settings.fontSize}px; line-height: {$settings.lineHeight};"
            >{@html rawGutterHtml}</div>
          {/if}
          <pre
            class="raw-source"
            class:with-gutter={rawGutterOn}
            style="font-size: {$settings.fontSize}px; line-height: {$settings.lineHeight};"
          ><code>{$docStore.content}</code></pre>
        </div>
      </main>
    {:else}
      <main
        class="content-main"
        class:toc-spaced={$tocVisible && $tocEntries.length > 0}
        class:concealed={canConceal && leftConcealed}
        data-focused={focusedLeft || undefined}
        use:glossary={{
          enabled: $glossaryMode && leftIsEnglish && glossLayoutOk,
          tabId: leftTab?.id ?? null,
          filePath: leftTab?.filePath ?? null,
        }}
        use:sentenceAction={{
          enabled: $sentenceMode && leftIsEnglish && glossLayoutOk,
          tabId: leftTab?.id ?? null,
          filePath: leftTab?.filePath ?? null,
        }}
        use:parasAction={{
          enabled: $parasMode && leftIsEnglish && glossLayoutOk,
          tabId: leftTab?.id ?? null,
          filePath: leftTab?.filePath ?? null,
          onCardState: (open) => (parasCardOpen = open),
        }}
      >
        <FrontmatterBar />
        <MarkdownRenderer
          html={leftTab?.renderedHtml ?? ""}
          secondary={!focusedLeft}
          onImageClick={(src, all, idx) => { lightboxImages = all; lightboxIndex = idx; lightboxVisible = true; }}
          onLocalLink={handleLocalLink}
        />
      </main>
    {/if}
    {#if rightOpen && !zenMode && !presenting}
      <!-- The second document, read-only, scrolling in its own column. A
           renderer only owns the shared TOC when its column has focus, so the
           `secondary` prop carries the inverse of that. -->
      <section
        class="side-pane"
        class:concealed={canConceal && rightConcealed}
        data-focused={!focusedLeft || undefined}
        use:glossary={{
          enabled: $glossaryMode && rightIsEnglish && glossLayoutOk,
          tabId: rightTab?.id ?? null,
          filePath: rightTab?.filePath ?? null,
        }}
        use:sentenceAction={{
          enabled: $sentenceMode && rightIsEnglish && glossLayoutOk,
          tabId: rightTab?.id ?? null,
          filePath: rightTab?.filePath ?? null,
        }}
        use:parasAction={{
          enabled: $parasMode && rightIsEnglish && glossLayoutOk,
          tabId: rightTab?.id ?? null,
          filePath: rightTab?.filePath ?? null,
          onCardState: (open) => (parasCardOpen = open),
        }}
      >
        {#if rightTab}
          <MarkdownRenderer
            html={rightTab.renderedHtml}
            secondary={focusedLeft}
            onImageClick={(src, all, idx) => { lightboxImages = all; lightboxIndex = idx; lightboxVisible = true; }}
            onLocalLink={handleLocalLink}
          />
        {/if}
      </section>
    {/if}
    {#if !zenMode && !activeTab?.isEditing && !presenting}
      <StatusBar />
      <ScrollToTop />
    {/if}
    <ImageLightbox bind:visible={lightboxVisible} src="" images={lightboxImages} bind:index={lightboxIndex} />
  {:else}
    <EmptyState onOpenUrl={() => { pasteDefaultMode = "url"; pasteVisible = true; }} />
  {/if}
  </div>
  <UpdateToast />
  <Toast />
</div>

<style>
  .page-root {
    background: #fafafa;
    color: #1c1c1e;
  }

  :global(html.dark) .page-root {
    background: #161618;
    color: #e5e5e7;
  }

  .state-center {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 75vh;
  }

  .state-text {
    font-size: 14px;
    color: #aeaeb2;
  }

  .pulse {
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }

  .error-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    max-width: 400px;
  }

  .error-msg {
    font-size: 13px;
    color: #8e8e93;
    line-height: 1.5;
  }

  .content-main {
    padding-bottom: 4rem;
    transition: padding-left 0.15s ease;
  }

  /* Split preview pane (#19): fixed right half, mirroring the editor's fixed
     left half. Scrolls independently. Sits below the toolbar and top tabs
     (`--chrome-top`, see utils/layout.ts). */
  .split-preview {
    position: fixed;
    top: var(--chrome-top, 88px);
    right: 0;
    /* The right half of what the side tabs panel leaves. */
    left: calc(var(--tabs-w, 0px) + (100% - var(--tabs-w, 0px)) / 2);
    bottom: 0;
    overflow-y: auto;
    padding-bottom: 4rem;
    z-index: 1;
    background: #fafafa;
  }

  :global(html.dark) .split-preview {
    background: #161618;
  }

  .content-main.toc-spaced {
    padding-left: var(--toc-w, 240px);
  }

  /* While the ToC edge is being dragged, drop the padding transition so the
     document tracks the pointer instead of easing a frame behind it, and stop
     the drag from selecting text as it sweeps across the page. */
  :global(html.toc-resizing) {
    cursor: col-resize;
    user-select: none;
  }

  :global(html.toc-resizing) .content-main {
    transition: none;
  }

  /* Everything in the document column clears the side tabs panel; 0 wide
     when the tabs are on top. The fixed parts (editor, split preview, ToC,
     status bar) offset themselves by the same variable. */
  .doc-area {
    padding-left: var(--tabs-w, 0px);
    /* Dual mode: the left column stops where the pinned document begins. */
    padding-right: var(--side-w, 0px);
    transition: padding-left 0.15s ease;
  }

  /* Dual mode's pinned document (#…): a read-only column of its own, scrolling
     independently, with the same sheet inside it. The primary document still
     scrolls the window, so nothing about its scroll position, search or ToC
     changes. */
  .side-pane {
    position: fixed;
    top: var(--chrome-top, 88px);
    right: 0;
    bottom: 0;
    width: var(--side-w, 0px);
    overflow-y: auto;
    padding-bottom: 4rem;
    z-index: 1;
    background: #fafafa;
    /* The seam between the two columns. Its pixel is counted in the window's
       width (page.ts SIDE_COLUMN_WIDTH), so the pinned sheet keeps its A4. */
    border-left: 1px solid #e5e5ea;
  }

  :global(html.dark) .side-pane {
    background: #161618;
    border-left-color: #2c2c2e;
  }

  /* Covering a column hides its contents, not its box: `visibility` keeps the
     layout height, scroll position and pane seam exactly where they were, so
     restoring a column never jumps the page. */
  :global(.content-main.concealed > *),
  :global(.side-pane.concealed > *) {
    visibility: hidden;
  }

  :global(html.tabs-resizing) {
    cursor: col-resize;
    user-select: none;
  }

  :global(html.tabs-resizing) .doc-area {
    transition: none;
  }

  .raw-stack {
    position: relative;
    margin: 0 auto;
  }

  .raw-source {
    margin: 0;
    padding: 24px 32px;
    font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
    color: #1c1c1e;
    white-space: pre-wrap;
    word-break: break-word;
    background: transparent;
    border: none;
  }

  :global(html.dark) .raw-source {
    color: #d1d1d6;
  }

  /* Line-number gutter (#110). The <pre> gains left padding to open the column;
     `measureLineOffsets` reads that padding off the element, so line-anchored
     scroll sync follows the narrower text automatically. */
  .raw-source.with-gutter {
    padding-left: calc(32px + var(--gutter-w));
  }

  /* Mirror of the <pre>: identical box, font and wrapping, transparent text.
     Only the CSS counters on each line block are visible. */
  .raw-gutter {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 24px 32px 24px calc(32px + var(--gutter-w));
    font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    box-sizing: border-box;
    color: transparent;
    pointer-events: none;
    user-select: none;
    overflow: hidden;
    counter-reset: gl;
  }

  .raw-gutter :global(.gl) {
    counter-increment: gl;
    position: relative;
  }

  .raw-gutter :global(.gl)::before {
    content: counter(gl);
    position: absolute;
    left: calc(-1 * var(--gutter-w));
    width: calc(var(--gutter-w) - 8px);
    text-align: right;
    color: #b0b0b5;
  }

  :global(html.dark) .raw-gutter :global(.gl)::before {
    color: #5a5a5e;
  }

  /* Faint tint + hairline divider for the gutter column, matching the editor. */
  .raw-stack.with-gutter::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 32px;
    width: var(--gutter-w);
    background: rgba(0, 0, 0, 0.02);
    border-right: 1px solid rgba(0, 0, 0, 0.06);
    pointer-events: none;
  }

  :global(html.dark) .raw-stack.with-gutter::before {
    background: rgba(255, 255, 255, 0.025);
    border-right-color: rgba(255, 255, 255, 0.08);
  }

  /* #110: app.css gives every <pre> a 1px print border. The gutter mirror is a
     <div>, so it does not get one — and 2px of content width is enough to wrap
     a long line differently in the two layers, drifting every number below it.
     That border is meant to delimit code blocks inside rendered markdown; the
     raw view is a single <pre> holding the whole document, where it also draws
     an unwanted box around the printout. Dropped here rather than in app.css so
     rendered code blocks keep it. */
  @media print {
    .raw-source {
      border: none !important;
    }
  }
</style>
