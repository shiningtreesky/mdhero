<script lang="ts">
  import { document } from "../stores/document";
  import { MOD } from "$lib/utils/platform";
  import {
    settings,
    setLineHeight,
    MIN_LINE_HEIGHT,
    MAX_LINE_HEIGHT,
    LINE_HEIGHT_STEP,
  } from "../stores/settings";
  import { themeMode, toggleTheme } from "../stores/theme";
  import { tocVisible, tocEntries, toggleToc, activeHeadingId } from "../stores/toc";
  import { openFileDialog } from "../tauri/files";
  import { copyAsRichText, copyAsMarkdown } from "../utils/clipboard";
  import { t, translate } from "$lib/i18n";
  import ReaderControls from "./ReaderControls.svelte";
  import brandLogo from "$lib/assets/mdhero-icon.png";
  import { Cog } from "@lucide/svelte";
  import { speechState, toggleSpeech, changeSpeechSpeed } from "$lib/tts/speech";
  import { setTtsHighlight, ttsSettings } from "$lib/stores/tts";
  import {
    LOOP_GAP_DEFAULT,
    LOOP_GAP_MAX,
    LOOP_GAP_MIN,
    loopGap,
  } from "$lib/stores/loopSpeech";
  import { TTS_MAX_SPEED, TTS_MIN_SPEED, TTS_SPEED_STEP } from "$lib/utils/tts";

  let {
    onPaste = () => {},
    onOpen = () => {},
    onUrl = () => {},
    rawMode = false,
    onRawToggle = () => {},
    isEditing = false,
    dirty = false,
    canSave = false,
    canEdit = false,
    editMode = "view",
    dual = false,
    onSetMode = (_m: "view" | "split" | "dual" | "edit") => {},
    /** Dual reading layout: the 左/右 cover buttons can act. */
    canConceal = false,
    /** Per-tab cover state; only meaningful while `canConceal`. */
    leftConcealed = false,
    rightConcealed = false,
    /** The focused column is covered, so its heading must not leak in the bar. */
    concealHeading = false,
    onToggleConcealLeft = () => {},
    onToggleConcealRight = () => {},
    onSave = () => {},
    onOpenSettings = () => {},
    canPresent = false,
    presenting = false,
    onTogglePresent = () => {},
    canTranslate = false,
    translating = false,
    translatingDirection = null,
    translateProgress = null,
    onTranslate = (_direction: "cn" | "en") => {},
    onOpenTranslationSettings = () => {},
    canSpeak = false,
    canGloss = false,
    glossActive = false,
    glossTitle = "",
    onToggleGloss = () => {},
    onOpenGlossSettings = () => {},
    /** Pin: keep every clicked word's gloss (词) or translation (句) on screen. */
    glossPinActive = false,
    /** Usable only with a reading mode on and a document saved to disk. */
    canPin = false,
    pinTitle = "",
    onToggleGlossPin = () => {},
    /** 音: 词 bubbles show IPA instead of the meaning. */
    canPhonetic = false,
    phoneticActive = false,
    phoneticTitle = "",
    onTogglePhonetic = () => {},
    /** Loop listening: clicking a word/sentence/paragraph repeats it. */
    canLoop = false,
    loopActive = false,
    loopTitle = "",
    onToggleLoop = () => {},
    /** Sentence reading ("句") mode: same interactions as 词, one sentence at a time. */
    canSentence = false,
    sentenceActive = false,
    sentenceTitle = "",
    onToggleSentence = () => {},
    /** 段: answer mode (cards + grading) vs reading whole paragraphs. */
    parasAnswerMode = false,
    parasSpeak = false,
    parasShowTranslation = true,
    onToggleParasAnswer = (_on: boolean) => {},
    onToggleParasSpeak = (_on: boolean) => {},
    onToggleParasShowTranslation = (_on: boolean) => {},
    /** Line spacing is adjustable while 词/句 pins or 段 reading are active. */
    lineSpacingEnabled = false,
    /** Paragraph reading ("段") mode: mutually exclusive with 句 and 词. */
    canParas = false,
    parasActive = false,
    parasTitle = "",
    parasTranslated = 0,
    parasTotal = 0,
    onToggleParas = () => {},
    /** 句: pin and translate every sentence of the active document at once. */
    canPinAllSentences = false,
    pinAllSentencesTitle = "",
    onPinAllSentences = () => {},
    /** 对比提交: scores every translated paragraph in one request. */
    canScore = false,
    scoring = false,
    scoreTitle = "",
    onScore = () => {},
    onOpenGraderSettings = () => {},
  }: {
    onPaste?: () => void;
    onOpen?: () => void;
    onUrl?: () => void;
    rawMode?: boolean;
    onRawToggle?: () => void;
    isEditing?: boolean;
    dirty?: boolean;
    /** Dirty, or a brand-new document whose first save is a Save As. */
    canSave?: boolean;
    canEdit?: boolean;
    editMode?: "view" | "split" | "edit";
    dual?: boolean;
    onSetMode?: (m: "view" | "split" | "dual" | "edit") => void;
    canConceal?: boolean;
    leftConcealed?: boolean;
    rightConcealed?: boolean;
    concealHeading?: boolean;
    onToggleConcealLeft?: () => void;
    onToggleConcealRight?: () => void;
    onSave?: () => void;
    onOpenSettings?: () => void;
    canPresent?: boolean;
    presenting?: boolean;
    onTogglePresent?: () => void;
    canTranslate?: boolean;
    translating?: boolean;
    translatingDirection?: "cn" | "en" | null;
    /** Completion percentage (0-100) of the running translation. */
    translateProgress?: number | null;
    onTranslate?: (direction: "cn" | "en") => void;
    onOpenTranslationSettings?: () => void;
    /** There is an active tab whose text can be read; an empty document still
     *  clicks through to a toast that says so. */
    canSpeak?: boolean;
    /** Reading ("词") mode: only in the dual reading view, English documents. */
    canGloss?: boolean;
    glossActive?: boolean;
    glossTitle?: string;
    onToggleGloss?: () => void;
    /** Long-press / right-click on the 词 button opens its own endpoint panel. */
    onOpenGlossSettings?: () => void;
    glossPinActive?: boolean;
    canPin?: boolean;
    pinTitle?: string;
    onToggleGlossPin?: () => void;
    /** 音: 词 bubbles show IPA instead of the meaning. */
    canPhonetic?: boolean;
    phoneticActive?: boolean;
    phoneticTitle?: string;
    onTogglePhonetic?: () => void;
    /** Loop listening: clicking a word/sentence/paragraph repeats it. */
    canLoop?: boolean;
    loopActive?: boolean;
    loopTitle?: string;
    onToggleLoop?: () => void;
    canSentence?: boolean;
    sentenceActive?: boolean;
    sentenceTitle?: string;
    onToggleSentence?: () => void;
    /** 段: answer mode (cards + grading) vs reading whole paragraphs. */
    parasAnswerMode?: boolean;
    parasSpeak?: boolean;
    parasShowTranslation?: boolean;
    onToggleParasAnswer?: (on: boolean) => void;
    onToggleParasSpeak?: (on: boolean) => void;
    onToggleParasShowTranslation?: (on: boolean) => void;
    /** Line spacing is adjustable while 词/句 pins or 段 reading are active. */
    lineSpacingEnabled?: boolean;
    canParas?: boolean;
    parasActive?: boolean;
    parasTitle?: string;
    /** Confirmed translations shown inside the 段 button as 8/23. */
    parasTranslated?: number;
    parasTotal?: number;
    onToggleParas?: () => void;
    /** 句: pin and translate every sentence of the active document at once. */
    canPinAllSentences?: boolean;
    pinAllSentencesTitle?: string;
    onPinAllSentences?: () => void;
    canScore?: boolean;
    scoring?: boolean;
    scoreTitle?: string;
    onScore?: () => void;
    onOpenGraderSettings?: () => void;
  } = $props();

  let currentHeading = $derived(
    $activeHeadingId && $tocEntries.length > 0
      ? $tocEntries.find((e) => e.id === $activeHeadingId)?.text ?? null
      : null
  );

  let showReaderControls = $state(false);
  let showCopyMenu = $state(false);
  let showSpeedPopover = $state(false);
  /** Right-click menu of the read-aloud button ("highlight the spoken sentence"). */
  let showSpeechMenu = $state(false);
  /** Right-click menu of the 段 button ("回答模式" / "朗读"). */
  let showParasMenu = $state(false);
  /** Loop button's right-click panel: the breath between passes, in seconds. */
  let showLoopMenu = $state(false);
  let loopGapInput = $state(String(LOOP_GAP_DEFAULT));
  let copyFeedback = $state("");

  let leftConcealTitle = $derived(
    !canConceal
      ? $t("toolbar.concealDisabled")
      : leftConcealed
        ? $t("toolbar.concealLeftShowTitle")
        : $t("toolbar.concealLeftTitle"),
  );
  let rightConcealTitle = $derived(
    !canConceal
      ? $t("toolbar.concealDisabled")
      : rightConcealed
        ? $t("toolbar.concealRightShowTitle")
        : $t("toolbar.concealRightTitle"),
  );

  let speechTitle = $derived(
    !canSpeak || isEditing
      ? isEditing
        ? $t("toolbar.speechTitleEditing")
        : $t("toolbar.speechTitleNoFile")
      : $speechState === "playing"
        ? $t("toolbar.pauseReading")
        : $speechState === "paused"
          ? $t("toolbar.resumeReading")
          : $speechState === "loading"
            ? $t("toolbar.stopReading")
            : $t("toolbar.readAloud"),
  );

  /** Closing the loop panel commits what was typed: removing it from the DOM
   *  does not fire blur, so a value typed before clicking elsewhere would
   *  otherwise be lost. */
  function closeLoopMenu() {
    if (showLoopMenu) commitLoopGap();
    showLoopMenu = false;
  }

  function closeAll() {
    showReaderControls = false;
    showCopyMenu = false;
    showSpeedPopover = false;
    showSpeechMenu = false;
    showParasMenu = false;
    closeLoopMenu();
  }

  /** Right-click on the loop button opens its settings instead of toggling. */
  function handleLoopContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const next = !showLoopMenu;
    closeAll();
    if (next) loopGapInput = String($loopGap);
    showLoopMenu = next;
  }

  /** Blur/Enter: clamp to 0.1–5 s, fall back to 0.7 for junk, mirror it back. */
  function commitLoopGap() {
    const raw = loopGapInput.trim();
    const parsed = raw === "" ? Number.NaN : Number(raw);
    loopGap.set(Number.isFinite(parsed) ? parsed : LOOP_GAP_DEFAULT);
    loopGapInput = String($loopGap);
  }

  function toggleReaderControls() {
    const next = !showReaderControls;
    closeAll();
    showReaderControls = next;
  }

  function toggleCopyMenu() {
    const next = !showCopyMenu;
    closeAll();
    showCopyMenu = next;
  }

  function toggleSpeedPopover() {
    const next = !showSpeedPopover;
    closeAll();
    showSpeedPopover = next;
  }

  function handleSpeechToggle() {
    closeAll();
    toggleSpeech();
  }

  /** Right-click on the play button opens its options instead of the webview's
   *  own menu; a short click keeps playing/pausing. */
  function handleSpeechContextMenu(event: MouseEvent) {
    event.preventDefault();
    const next = !showSpeechMenu;
    closeAll();
    showSpeechMenu = next;
  }

  function handleSpeechHighlightChange(event: Event) {
    setTtsHighlight((event.currentTarget as HTMLInputElement).checked);
  }

  function handleSpeedInput(event: Event) {
    changeSpeechSpeed(Number((event.currentTarget as HTMLInputElement).value));
  }

  function handleThemeToggle() {
    closeAll();
    toggleTheme();
  }

  // Long-press (or right-click) on 词 opens its own endpoint panel instead of
  // toggling the mode; a short press still toggles. `glossLongPressed` swallows
  // the click that follows a long press.
  let glossPressTimer: ReturnType<typeof setTimeout> | undefined;
  let glossLongPressed = false;

  function startGlossPress() {
    clearTimeout(glossPressTimer);
    glossPressTimer = setTimeout(() => {
      glossLongPressed = true;
      onOpenGlossSettings();
    }, 600);
  }

  function cancelGlossPress() {
    clearTimeout(glossPressTimer);
  }

  function handleGlossClick() {
    if (glossLongPressed) {
      glossLongPressed = false;
      return;
    }
    closeAll();
    onToggleGloss();
  }

  function handleGlossContextMenu(event: MouseEvent) {
    event.preventDefault();
    cancelGlossPress();
    glossLongPressed = false;
    onOpenGlossSettings();
  }

  // The 句 button uses the same gesture as 词: a short press toggles the mode,
  // a long press / right-click opens the shared endpoint panel.
  let sentencePressTimer: ReturnType<typeof setTimeout> | undefined;
  let sentenceLongPressed = false;

  function startSentencePress() {
    clearTimeout(sentencePressTimer);
    sentencePressTimer = setTimeout(() => {
      sentenceLongPressed = true;
      onOpenGlossSettings();
    }, 600);
  }

  function cancelSentencePress() {
    clearTimeout(sentencePressTimer);
  }

  function handleSentenceClick() {
    if (sentenceLongPressed) {
      sentenceLongPressed = false;
      return;
    }
    closeAll();
    onToggleSentence();
  }

  function handleSentenceContextMenu(event: MouseEvent) {
    event.preventDefault();
    cancelSentencePress();
    sentenceLongPressed = false;
    onOpenGlossSettings();
  }

  // 段 shares the 词/句 gesture too: long-press / right-click opens the same
  // settings panel, where the "朗读" option turns on card auto-read.
  let parasPressTimer: ReturnType<typeof setTimeout> | undefined;
  let parasLongPressed = false;

  function startParasPress() {
    clearTimeout(parasPressTimer);
    parasPressTimer = setTimeout(() => {
      parasLongPressed = true;
      onOpenGlossSettings();
    }, 600);
  }

  function cancelParasPress() {
    clearTimeout(parasPressTimer);
  }

  function handleParasClick() {
    if (parasLongPressed) {
      parasLongPressed = false;
      return;
    }
    closeAll();
    onToggleParas();
  }

  function handleParasContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    cancelParasPress();
    parasLongPressed = false;
    const next = !showParasMenu;
    closeAll();
    showParasMenu = next;
  }

  /** Clicks inside the menu keep it open; anything else closes it. */
  function handleOutsidePointerDown(event: PointerEvent) {
    if (!showSpeechMenu && !showParasMenu && !showLoopMenu) return;
    const target = event.target as Element | null;
    if (showSpeechMenu && target?.closest?.(".speech-group")) return;
    if (showParasMenu && target?.closest?.(".paras-group")) return;
    if (showLoopMenu && target?.closest?.(".loop-group")) return;
    showSpeechMenu = false;
    showParasMenu = false;
    closeLoopMenu();
  }

  // Same gesture on 对比提交: short press submits, long press / right-click
  // opens the grading endpoint panel. It is never natively disabled so those
  // gestures keep working while the button looks greyed out.
  let scorePressTimer: ReturnType<typeof setTimeout> | undefined;
  let scoreLongPressed = false;

  function startScorePress() {
    clearTimeout(scorePressTimer);
    scorePressTimer = setTimeout(() => {
      scoreLongPressed = true;
      onOpenGraderSettings();
    }, 600);
  }

  function cancelScorePress() {
    clearTimeout(scorePressTimer);
  }

  function handleScoreClick() {
    if (scoreLongPressed) {
      scoreLongPressed = false;
      return;
    }
    if (scoring) return;
    closeAll();
    onScore();
  }

  function handleScoreContextMenu(event: MouseEvent) {
    event.preventDefault();
    cancelScorePress();
    scoreLongPressed = false;
    onOpenGraderSettings();
  }

  function toggleWidthMode() {
    closeAll();
    settings.update((s) => ({
      ...s,
      widthMode: s.widthMode === "wide" ? "comfortable" : "wide",
    }));
  }

  /** Leading of the reading panes, shared with the Aa panel's slider. Only
   *  meaningful while words or sentences are pinned: opening the lines up is
   *  how a reader gets the text out from behind a pinned gloss. */
  let lineSpacingDisabled = $derived(!canSpeak || !lineSpacingEnabled);
  let lineSpacingTitle = $derived(
    !canSpeak
      ? $t("toolbar.lineSpacingNoFile")
      : !lineSpacingEnabled
        ? $t("toolbar.lineSpacingNeedsPin")
        : $t("toolbar.lineSpacing"),
  );

  function stepLineHeight(direction: 1 | -1) {
    setLineHeight($settings.lineHeight + direction * LINE_HEIGHT_STEP);
  }

  function handleLineHeightInput(event: Event) {
    setLineHeight((event.currentTarget as HTMLInputElement).value);
  }

  // `@tauri-apps/api` exposes no print() on Webview or Window (checked through
  // 2.11), so the former try-branch calling `getCurrentWebview().print()` was
  // undefined at runtime and always fell through to this. Same behaviour, no
  // dead code, no type error.
  function handleExportPdf() {
    window.print();
  }

  async function handleCopyRichText() {
    const article = globalThis.document?.querySelector("article.prose");
    if (!article || !$document.content) return;
    const success = await copyAsRichText(article.innerHTML, $document.content);
    copyFeedback = success ? translate("common.copied") : translate("common.copyFailed");
    showCopyMenu = false;
    setTimeout(() => (copyFeedback = ""), 1500);
  }

  async function handleCopyMarkdown() {
    if (!$document.content) return;
    const success = await copyAsMarkdown($document.content);
    copyFeedback = success ? translate("common.copied") : translate("common.copyFailed");
    showCopyMenu = false;
    setTimeout(() => (copyFeedback = ""), 1500);
  }

  function getThemeIcon(mode: string): string {
    switch (mode) {
      case "light": return "\u2600";
      case "dark": return "\u263E";
      default: return "\u25D1";
    }
  }
</script>

<svelte:document onpointerdown={handleOutsidePointerDown} />

<header class="toolbar">
  <div class="toolbar-left">
    <img src={brandLogo} alt="MDHero" width="26" height="26" class="toolbar-logo" />
    <span class="toolbar-wordmark">MDHero</span>
    <div class="btn-group">
      <button onclick={onOpen} class="btn btn-primary" title={$t('toolbar.openTitle', { mod: MOD })}>
        {$t('toolbar.open')}
      </button>
      <button onclick={onPaste} class="btn btn-ghost" title={$t('toolbar.pasteTitle', { mod: MOD })}>
        {$t('toolbar.paste')}
      </button>
      <button onclick={onUrl} class="btn btn-ghost" title={$t('toolbar.openUrlTitle')}>
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5.5"/><ellipse cx="7" cy="7" rx="2.5" ry="5.5"/><line x1="1.5" y1="7" x2="12.5" y2="7"/></svg>
      </button>
    </div>

    {#if $document.fileName && currentHeading && !concealHeading}
      <span class="current-heading" title={currentHeading}>{currentHeading}</span>
    {/if}
  </div>

  <div class="toolbar-right">
    <!-- 左/右: cover one reading column while the other stays visible. Each
         is an independent toggle, so both can be covered at once; the state
         is per tab and only applies in the dual reading layout. -->
    <div class="conceal-group" role="group" aria-label={$t('toolbar.concealAria')}>
      <button
        class="conceal-btn"
        class:active={canConceal && leftConcealed}
        disabled={!canConceal}
        aria-pressed={canConceal && leftConcealed}
        aria-label={leftConcealTitle}
        title={leftConcealTitle}
        onclick={() => { closeAll(); onToggleConcealLeft(); }}
      >{$t('toolbar.concealLeft')}</button>
      <button
        class="conceal-btn"
        class:active={canConceal && rightConcealed}
        disabled={!canConceal}
        aria-pressed={canConceal && rightConcealed}
        aria-label={rightConcealTitle}
        title={rightConcealTitle}
        onclick={() => { closeAll(); onToggleConcealRight(); }}
      >{$t('toolbar.concealRight')}</button>
    </div>

    <!-- View / Split / Edit segmented control: leads the right button group so
         the right side keeps room for new buttons. Split & Edit need an
         editable local file; when there isn't one they disable with an
         explaining tip. -->
    <div
      class="mode-segmented"
      role="group"
      aria-label={$t('toolbar.viewModeAria')}
      title={!$document.filePath
        ? $t('toolbar.modeTitleNoFile')
        : !canEdit
        ? $t('toolbar.modeTitleNoEdit')
        : $t('toolbar.modeTitle')}
    >
      <button
        class="mode-seg"
        class:active={editMode === 'view'}
        onclick={() => onSetMode('view')}
        disabled={!$document.filePath}
      >{$t('toolbar.view')}</button>
      <button
        class="mode-seg"
        class:active={editMode === 'split'}
        onclick={() => onSetMode('split')}
        disabled={!canEdit}
      >{$t('toolbar.split')}</button>
      <!-- Dual is a second column, not a left-pane mode: it stays highlighted
           while the left column switches between view and edit. It needs a
           document, not an editable one, so URL and paste tabs work too. -->
      <button
        class="mode-seg"
        class:active={dual}
        onclick={() => onSetMode('dual')}
        disabled={!$document.filePath}
      >{$t('toolbar.dual')}</button>
      <button
        class="mode-seg"
        class:active={editMode === 'edit'}
        onclick={() => onSetMode('edit')}
        disabled={!canEdit}
      >{$t('toolbar.edit')}</button>
    </div>

    <!-- 对比提交: one request covering every translated paragraph. Kept
         clickable even when unavailable so right-click / long-press can open
         the grading endpoint panel. -->
    <button
      class="btn score-btn"
      class:scoring
      class:inactive={!canScore}
      aria-disabled={!canScore || scoring}
      title={scoreTitle}
      aria-label={$t('toolbar.score')}
      onclick={handleScoreClick}
      onpointerdown={startScorePress}
      onpointerup={cancelScorePress}
      onpointerleave={cancelScorePress}
      onpointercancel={cancelScorePress}
      oncontextmenu={handleScoreContextMenu}
    >{#if scoring}{$t('toolbar.grading')}{:else}{$t('toolbar.score')}{/if}</button>

    <!-- 句: one click pins and translates every sentence of the active document,
         for readers who would otherwise click each sentence by hand. Blue like
         the view/dual switcher, not the amber 句 mode button. -->
    <button
      class="btn gloss-btn sentence-all-btn"
      disabled={!canPinAllSentences}
      title={pinAllSentencesTitle}
      aria-label={$t('toolbar.pinAllSentencesTitle')}
      onclick={onPinAllSentences}
    >{$t('toolbar.pinAllSentences')}</button>

    <!-- Paragraph ("段") mode. Right-click opens its own menu: 回答模式 switches
         between the card/grading workflow and whole-paragraph reading. -->
    <div class="paras-group">
      <button
        class="btn gloss-btn"
        class:active={parasActive}
        disabled={!canParas}
        title={parasTitle}
        aria-label={$t('toolbar.paras')}
        aria-pressed={parasActive}
        aria-haspopup="true"
        aria-expanded={showParasMenu}
        onclick={handleParasClick}
        onpointerdown={startParasPress}
        onpointerup={cancelParasPress}
        onpointerleave={cancelParasPress}
        onpointercancel={cancelParasPress}
        oncontextmenu={handleParasContextMenu}
      >{$t('toolbar.paras')}{#if parasActive && !parasAnswerMode && parasTotal > 0}<span class="paras-progress">{parasTranslated}/{parasTotal}</span>{/if}</button>

      {#if showParasMenu}
        <div class="speech-menu paras-menu" role="menu" aria-label={$t('toolbar.parasMenu')}>
          <label class="speech-menu-item">
            <input
              type="checkbox"
              checked={parasAnswerMode}
              onchange={(event) => onToggleParasAnswer(event.currentTarget.checked)}
            />
            <span>{$t('toolbar.parasAnswerMode')}</span>
          </label>
          <label class="speech-menu-item">
            <input
              type="checkbox"
              checked={parasSpeak}
              onchange={(event) => onToggleParasSpeak(event.currentTarget.checked)}
            />
            <span>{$t('toolbar.parasReadAloud')}</span>
          </label>
          <label class="speech-menu-item">
            <input
              type="checkbox"
              checked={parasShowTranslation}
              onchange={(event) => onToggleParasShowTranslation(event.currentTarget.checked)}
            />
            <span>{$t('toolbar.parasShowTranslation')}</span>
          </label>
          <button
            type="button"
            class="speech-menu-item speech-menu-action"
            onclick={() => {
              showParasMenu = false;
              onOpenGlossSettings();
            }}
          >{$t('toolbar.translationSettings')}</button>
        </div>
      {/if}
    </div>

    <!-- Sentence ("句") mode: same as 词, but the unit is a whole sentence.
         Long-press / right-click opens the shared gloss endpoint settings. -->
    <button
      class="btn gloss-btn"
      class:active={sentenceActive}
      disabled={!canSentence}
      title={sentenceTitle}
      aria-label={$t('toolbar.sentence')}
      aria-pressed={sentenceActive}
      onclick={handleSentenceClick}
      onpointerdown={startSentencePress}
      onpointerup={cancelSentencePress}
      onpointerleave={cancelSentencePress}
      onpointercancel={cancelSentencePress}
      oncontextmenu={handleSentenceContextMenu}
    >{$t('toolbar.sentence')}</button>

    <!-- Reading ("词") mode: toggles word glosses in the dual reading pane.
         Long-press / right-click opens this mode's own endpoint settings. -->
    <button
      class="btn gloss-btn"
      class:active={glossActive}
      disabled={!canGloss}
      title={glossTitle}
      aria-label={$t('toolbar.gloss')}
      aria-pressed={glossActive}
      onclick={handleGlossClick}
      onpointerdown={startGlossPress}
      onpointerup={cancelGlossPress}
      onpointerleave={cancelGlossPress}
      onpointercancel={cancelGlossPress}
      oncontextmenu={handleGlossContextMenu}
    >{$t('toolbar.gloss')}</button>

    <!-- 音: the same 词 bubbles, showing IPA instead of the meaning. `4` flips
         it; the IPA is pre-fetched even when the 音标 setting is off. -->
    <button
      class="btn gloss-btn"
      class:active={phoneticActive}
      disabled={!canPhonetic}
      title={phoneticTitle}
      aria-label={$t('toolbar.phonetic')}
      aria-pressed={phoneticActive}
      onclick={onTogglePhonetic}
    >{$t('toolbar.phonetic')}</button>

    <!-- Pin: with 词 mode on, clicked words keep their highlight and gloss
         bubble until Ctrl/Cmd+click removes them. ESC hides the bubbles but
         leaves the highlights. -->
    <button
      class="btn gloss-btn gloss-pin-btn"
      class:active={glossPinActive}
      disabled={!canPin}
      title={pinTitle}
      aria-label={$t('toolbar.glossPin')}
      aria-pressed={glossPinActive}
      onclick={onToggleGlossPin}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
        <path d="M12 14v7" />
      </svg>
    </button>

    <!-- Loop listening: clicking a word, sentence or paragraph repeats it with
         a breath between passes until clicked again. Right-click opens the
         breath length. -->
    <div class="loop-group">
      <button
        class="btn gloss-btn gloss-loop-btn"
        class:active={loopActive}
        disabled={!canLoop}
        title={loopTitle}
        aria-label={$t('toolbar.loop')}
        aria-pressed={loopActive}
        aria-haspopup="true"
        aria-expanded={showLoopMenu}
        onclick={onToggleLoop}
        oncontextmenu={handleLoopContextMenu}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 2l4 4-4 4" />
          <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
          <path d="M7 22l-4-4 4-4" />
          <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </svg>
      </button>
      {#if showLoopMenu}
        <div class="speech-menu loop-menu" role="menu" aria-label={$t('toolbar.loopMenu')}>
          <label class="loop-gap-field">
            <span>{$t('toolbar.loopGap')}</span>
            <input
              class="loop-gap-input"
              type="number"
              min={LOOP_GAP_MIN}
              max={LOOP_GAP_MAX}
              step="0.1"
              value={loopGapInput}
              oninput={(event) => (loopGapInput = event.currentTarget.value)}
              onchange={commitLoopGap}
              onblur={commitLoopGap}
              onkeydown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span class="loop-gap-unit">{$t('toolbar.loopGapUnit')}</span>
          </label>
        </div>
      {/if}
    </div>

    <div class="separator"></div>

    <!-- Read the whole active tab aloud: play/pause on the left of the
         translation buttons, with the rate control next to it. -->
    <div class="speech-group" role="group" aria-label={$t('toolbar.readAloud')}>
      <button
        onclick={handleSpeechToggle}
        oncontextmenu={handleSpeechContextMenu}
        class="btn btn-icon speech-btn"
        class:active={$speechState !== "idle"}
        disabled={!canSpeak || isEditing}
        title={speechTitle}
        aria-label={speechTitle}
        aria-haspopup="true"
        aria-expanded={showSpeechMenu}
      >
        {#if $speechState === "playing"}
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="4" y="2.5" width="3" height="11" rx="0.8"/>
            <rect x="9" y="2.5" width="3" height="11" rx="0.8"/>
          </svg>
        {:else if $speechState === "loading"}
          <svg class="spin" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2"/>
            <circle cx="8" cy="8" r="6.2" opacity="0.25"/>
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M5 2.6a.6.6 0 0 1 .9-.5l7.6 5a.6.6 0 0 1 0 1l-7.6 5a.6.6 0 0 1-.9-.5z"/>
          </svg>
        {/if}
      </button>

      <div class="relative">
        <button
          onclick={toggleSpeedPopover}
          class="btn speed-btn"
          title={$t('toolbar.speechRate')}
          aria-label={$t('toolbar.speechRateAria')}
          aria-expanded={showSpeedPopover}
        >{($ttsSettings.speed).toFixed(1)}×</button>

        {#if showSpeedPopover}
          <div class="speed-popover" role="group" aria-label={$t('toolbar.speechRateAria')}>
            <div class="speed-popover-head">
              <span>{$t('toolbar.speechRate')}</span>
              <span class="speed-value">{($ttsSettings.speed).toFixed(1)}×</span>
            </div>
            <input
              class="speed-slider"
              type="range"
              min={TTS_MIN_SPEED}
              max={TTS_MAX_SPEED}
              step={TTS_SPEED_STEP}
              value={$ttsSettings.speed}
              oninput={handleSpeedInput}
              aria-label={$t('toolbar.speechRateAria')}
            />
            <div class="speed-scale">
              <span>{TTS_MIN_SPEED.toFixed(1)}×</span>
              <span>{TTS_MAX_SPEED.toFixed(1)}×</span>
            </div>
          </div>
        {/if}
      </div>

      {#if showSpeechMenu}
        <div class="speech-menu" role="menu" aria-label={$t('toolbar.speechOptions')}>
          <label class="speech-menu-item">
            <input
              type="checkbox"
              checked={$ttsSettings.highlight}
              onchange={handleSpeechHighlightChange}
            />
            <span>{$t('toolbar.speechHighlight')}</span>
          </label>
        </div>
      {/if}
    </div>

    <div class="separator"></div>

    <div class="translate-group" role="group" aria-label={$t('toolbar.translationSettings')}>
      <button
        onclick={() => { closeAll(); onTranslate("cn"); }}
        class="btn translate-btn"
        class:active={translatingDirection === "cn"}
        disabled={!canTranslate || translating}
        title={translating ? $t('toolbar.translating') : $t('toolbar.translateCn')}
        aria-label={$t('toolbar.translateCn')}
      >cn{#if translating && translatingDirection === "cn" && translateProgress !== null}<span class="translate-progress">{translateProgress}%</span>{/if}</button>
      <button
        onclick={() => { closeAll(); onTranslate("en"); }}
        class="btn translate-btn"
        class:active={translatingDirection === "en"}
        disabled={!canTranslate || translating}
        title={translating ? $t('toolbar.translating') : $t('toolbar.translateEn')}
        aria-label={$t('toolbar.translateEn')}
      >en{#if translating && translatingDirection === "en" && translateProgress !== null}<span class="translate-progress">{translateProgress}%</span>{/if}</button>
      <button
        onclick={() => { closeAll(); onOpenTranslationSettings(); }}
        class="btn btn-icon translate-settings-btn"
        disabled={translating}
        title={$t('toolbar.translationSettings')}
        aria-label={$t('toolbar.translationSettings')}
      >
        <Cog size={18} />
      </button>
    </div>

    <div class="separator"></div>

    <button
      onclick={toggleToc}
      class="btn btn-icon"
      class:active={$tocVisible}
      disabled={!$document.renderedHtml || $tocEntries.length === 0 || isEditing}
      title={!$document.renderedHtml
        ? $t('toolbar.tocTitleNoHtml')
        : isEditing
        ? $t('toolbar.tocTitleEditing')
        : $tocEntries.length === 0
        ? $t('toolbar.tocTitleNoHeadings')
        : $t('toolbar.tocTitle')}
    >
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="10" y2="8"/><line x1="2" y1="12" x2="12" y2="12"/></svg>
    </button>

    <div
      class="line-spacing"
      role="group"
      aria-label={$t('toolbar.lineSpacing')}
      title={lineSpacingTitle}
    >
      <button
        type="button"
        class="ls-step"
        onclick={() => stepLineHeight(-1)}
        disabled={lineSpacingDisabled}
        aria-label={$t('toolbar.lineSpacingDecrease')}
        tabindex="-1"
      >−</button>
      <input
        class="ls-value"
        type="number"
        inputmode="decimal"
        min={MIN_LINE_HEIGHT}
        max={MAX_LINE_HEIGHT}
        step={LINE_HEIGHT_STEP}
        value={$settings.lineHeight.toFixed(1)}
        onchange={handleLineHeightInput}
        disabled={lineSpacingDisabled}
        aria-label={$t('toolbar.lineSpacing')}
      />
      <button
        type="button"
        class="ls-step"
        onclick={() => stepLineHeight(1)}
        disabled={lineSpacingDisabled}
        aria-label={$t('toolbar.lineSpacingIncrease')}
        tabindex="-1"
      >+</button>
    </div>

    <button
      onclick={toggleReaderControls}
      class="btn btn-icon"
      class:active={showReaderControls}
      disabled={!$document.renderedHtml}
      title={$document.renderedHtml ? $t('toolbar.readerTitle') : $t('toolbar.readerTitleNoFile')}
    >
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><text x="1" y="12" font-size="12" font-weight="700" stroke="none" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, sans-serif">Aa</text></svg>
    </button>

    <button
      onclick={toggleWidthMode}
      class="btn btn-icon"
      class:active={$settings.widthMode === "wide"}
      disabled={!$document.renderedHtml}
      title={!$document.renderedHtml
        ? $t('toolbar.widthTitleNoFile')
        : $settings.widthMode === "wide"
        ? $t('toolbar.useComfortable')
        : $t('toolbar.useWide')}
      aria-label={$settings.widthMode === "wide" ? $t('toolbar.useComfortable') : $t('toolbar.useWide')}
    >
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.5 5.5V3.5h2" />
        <path d="M13.5 5.5V3.5h-2" />
        <path d="M2.5 10.5v2h2" />
        <path d="M13.5 10.5v2h-2" />
        <path d="M5.5 8h5" />
        <path d="M4 8l1.5-1.5" />
        <path d="M4 8l1.5 1.5" />
        <path d="M12 8l-1.5-1.5" />
        <path d="M12 8l-1.5 1.5" />
      </svg>
    </button>

    <button
      onclick={onRawToggle}
      class="btn btn-icon"
      class:active={rawMode}
      disabled={!$document.renderedHtml || isEditing}
      title={!$document.renderedHtml
        ? $t('toolbar.rawTitleNoFile')
        : isEditing
        ? $t('toolbar.rawTitleEditing')
        : $t('toolbar.rawTitle', { mod: MOD })}
    >
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6,5 2,8 6,11"/>
        <polyline points="10,5 14,8 10,11"/>
        <line x1="9" y1="3" x2="7" y2="13"/>
      </svg>
    </button>

    {#if canPresent}
      <button
        onclick={onTogglePresent}
        class="btn btn-icon"
        class:active={presenting}
        title={presenting ? $t('toolbar.exitPresentTitle') : $t('toolbar.presentTitle')}
        aria-label={presenting ? $t('toolbar.exitPresentAria') : $t('toolbar.presentTitle')}
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1.5" y="2.5" width="13" height="9" rx="1"/>
          <line x1="6" y1="14" x2="10" y2="14"/>
          <line x1="8" y1="11.5" x2="8" y2="14"/>
        </svg>
      </button>
    {/if}

    <button
      onclick={onSave}
      class="btn btn-icon save-btn"
      class:dirty
      disabled={!canSave}
      title={canSave ? $t('toolbar.saveDirty', { mod: MOD }) : $t('toolbar.saveClean')}
    >
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 3h8l2 2v8H3z"/>
        <path d="M5 3v4h6V3"/>
        <rect x="5" y="9" width="6" height="4"/>
      </svg>
      {#if dirty}
        <span class="dirty-dot"></span>
      {/if}
    </button>

    <div class="relative">
      <button
        onclick={toggleCopyMenu}
        class="btn btn-icon"
        disabled={!$document.renderedHtml || isEditing}
        title={!$document.renderedHtml
          ? $t('toolbar.copyTitleNoFile')
          : isEditing
          ? $t('toolbar.copyTitleEditing')
          : $t('toolbar.copyTitle')}
      >
        {#if copyFeedback}
          <span style="font-size:11px">{copyFeedback}</span>
        {:else}
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3h8"/></svg>
        {/if}
      </button>

      {#if showCopyMenu}
        <div class="dropdown">
          <button onclick={handleCopyRichText} class="dropdown-item">
            <span>{$t('toolbar.copyRichText')}</span>
            <span class="dropdown-hint">{$t('toolbar.copyRichTextHint')}</span>
          </button>
          <button onclick={handleCopyMarkdown} class="dropdown-item">
            <span>{$t('toolbar.copyMarkdown')}</span>
            <span class="dropdown-hint">{$t('toolbar.copyMarkdownHint')}</span>
          </button>
        </div>
      {/if}
    </div>

    <button
      onclick={handleExportPdf}
      class="btn btn-icon"
      disabled={!$document.renderedHtml || isEditing}
      title={!$document.renderedHtml
        ? $t('toolbar.pdfTitleNoFile')
        : isEditing
        ? $t('toolbar.pdfTitleEditing')
        : $t('toolbar.pdfTitle')}
    >
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 2h6l3 3v9H4z"/>
        <path d="M10 2v3h3"/>
        <polyline points="6,9 8,11 10,9"/>
        <line x1="8" y1="7" x2="8" y2="11"/>
      </svg>
    </button>

    <div class="separator"></div>

    <button
      onclick={() => { closeAll(); onOpenSettings(); }}
      class="btn btn-icon"
      title={$t('toolbar.settings', { mod: MOD })}
      aria-label={$t('toolbar.settingsAria')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>

    <button onclick={handleThemeToggle} class="btn btn-icon" title={$t('toolbar.theme')}>
      {getThemeIcon($themeMode)}
    </button>
  </div>
</header>

{#if showCopyMenu || showReaderControls || showSpeedPopover}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-[9]" onclick={closeAll} onkeydown={() => {}}></div>
{/if}

<ReaderControls visible={showReaderControls} />

<style>
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: rgba(250, 250, 250, 0.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid #e5e5e5;
  }

  :global(html.dark) .toolbar {
    background: rgba(22, 22, 24, 0.85);
    border-bottom-color: #2c2c2e;
  }

  /* The left group yields space first: the logo and buttons never shrink, the
     heading ellipsizes, and at extreme widths it collapses to zero width. */
  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }

  .toolbar-logo {
    flex-shrink: 0;
    border-radius: 6px;
    display: block;
  }

  .toolbar-wordmark {
    flex-shrink: 0;
    font-size: 17px;
    font-weight: 600;
    color: #1c1c1e;
    letter-spacing: -0.01em;
    margin-left: -3px;
  }

  :global(html.dark) .toolbar-wordmark {
    color: #e5e5e7;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    /* Keeps the cluster right-aligned even when the left group is hidden. */
    margin-left: auto;
  }

  .translate-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  /* Reading line spacing: − value +, tucked left of the Aa panel button. */
  .line-spacing {
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 1px;
    margin-right: 2px;
    border: 1px solid #e5e5ea;
    border-radius: 7px;
    background: #f6f6f8;
  }

  :global(html.dark) .line-spacing {
    border-color: #3a3a3c;
    background: #1c1c1e;
  }

  .line-spacing:focus-within {
    border-color: #0891b2;
  }

  .ls-step {
    width: 18px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: #636366;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }

  .ls-step:hover:not(:disabled) {
    background: #e5e5ea;
  }

  :global(html.dark) .ls-step {
    color: #aeaeb2;
  }

  :global(html.dark) .ls-step:hover:not(:disabled) {
    background: #3a3a3c;
  }

  .ls-step:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ls-value {
    width: 34px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    color: #1c1c1e;
    font-size: 11px;
    font-family: "SF Mono", "JetBrains Mono", monospace;
    text-align: center;
    appearance: textfield;
    -moz-appearance: textfield;
  }

  .ls-value::-webkit-outer-spin-button,
  .ls-value::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  :global(html.dark) .ls-value {
    color: #e5e5e7;
  }

  .ls-value:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .speech-group {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
  }

  /* The 段 button's own right-click menu anchors to it. */
  .paras-group {
    position: relative;
    display: inline-flex;
  }

  .loop-group {
    position: relative;
    display: inline-flex;
  }

  /* Opens toward the left edge of the button: it sits near the right end. */
  .loop-menu {
    left: auto;
    right: 0;
    min-width: 168px;
  }

  .loop-gap-field {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    font-size: 12px;
    color: #1c1c1e;
    white-space: nowrap;
  }

  :global(html.dark) .loop-gap-field {
    color: #e5e5e7;
  }

  .loop-gap-input {
    width: 58px;
    padding: 3px 6px;
    border: 1px solid #d1d1d6;
    border-radius: 5px;
    font-size: 12px;
    color: #1c1c1e;
    background: white;
  }

  :global(html.dark) .loop-gap-input {
    color: #e5e5e7;
    background: #1c1c1e;
    border-color: #3a3a3c;
  }

  .loop-gap-unit {
    color: #8e8e93;
  }

  .speech-menu-action {
    width: 100%;
    border: none;
    background: transparent;
    text-align: left;
    font-size: 12px;
    color: #1c1c1e;
    cursor: pointer;
  }

  .speech-menu-action:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .speech-menu-action {
    color: #e5e5e7;
  }

  :global(html.dark) .speech-menu-action:hover {
    background: #3a3a3c;
  }

  /* Right-click menu of the play button, opened like the speed popover. */
  .speech-menu {
    position: absolute;
    left: 0;
    top: calc(100% + 6px);
    min-width: 152px;
    padding: 4px;
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.06);
    z-index: 50;
  }

  :global(html.dark) .speech-menu {
    background: #2c2c2e;
    border-color: #3a3a3c;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .speech-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 12px;
    color: #1c1c1e;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }

  :global(html.dark) .speech-menu-item {
    color: #e5e5e7;
  }

  .speech-menu-item:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .speech-menu-item:hover {
    background: #3a3a3c;
  }

  .speech-menu-item input {
    margin: 0;
    accent-color: #0891b2;
  }

  .speech-btn {
    padding: 4px 8px;
  }

  /* While loading, a click cancels the pending playback, so keep it clickable. */
  .speech-btn.active:disabled {
    opacity: 0.7;
    cursor: default;
  }

  .speed-btn {
    padding: 4px 7px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #3a3a3c;
    background: transparent;
    font-variant-numeric: tabular-nums;
  }

  .speed-btn:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .speed-btn {
    color: #aeaeb2;
  }

  :global(html.dark) .speed-btn:hover {
    background: #2c2c2e;
  }

  .speed-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    width: 196px;
    padding: 10px 12px 8px;
    background: white;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.06);
    z-index: 50;
  }

  :global(html.dark) .speed-popover {
    background: #2c2c2e;
    border-color: #3a3a3c;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .speed-popover-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: #5f6368;
    margin-bottom: 6px;
  }

  :global(html.dark) .speed-popover-head {
    color: #aeaeb2;
  }

  .speed-value {
    font-weight: 600;
    color: #0891b2;
    font-variant-numeric: tabular-nums;
  }

  :global(html.dark) .speed-value {
    color: #22d3ee;
  }

  .speed-slider {
    width: 100%;
    accent-color: #0891b2;
    cursor: pointer;
  }

  .speed-scale {
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
    font-size: 10px;
    color: #aeaeb2;
  }

  .spin {
    animation: speech-spin 0.9s linear infinite;
    transform-origin: 50% 50%;
  }

  @keyframes speech-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .translate-btn {
    padding: 4px 9px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #0891b2;
    background: #e5f5f8;
  }

  .translate-btn:hover:not(:disabled):not(.active) {
    background: #d4eef3;
    color: #0e7490;
  }

  .translate-btn.active {
    background: #0891b2;
    color: #ffffff;
  }

  .translate-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* The button running the translation stays legible so its progress is
     readable, even though it is disabled against repeat clicks. */
  .translate-btn.active:disabled {
    opacity: 1;
    cursor: default;
  }

  .translate-progress {
    margin-left: 4px;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  :global(html.dark) .translate-btn {
    color: #22d3ee;
    background: #0a1e2e;
  }

  :global(html.dark) .translate-btn:hover:not(:disabled):not(.active) {
    background: #14304a;
  }

  :global(html.dark) .translate-btn.active {
    background: #0891b2;
    color: #ffffff;
  }

  .translate-settings-btn {
    padding: 5px 8px;
  }

  /* Reading mode toggles (段/句/词): text buttons, idle-neutral and amber when on. */
  .gloss-btn {
    padding: 4px 9px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #3a3a3c;
    background: transparent;
  }

  .gloss-btn:hover:not(:disabled):not(.active) {
    background: #f2f2f7;
    color: #1c1c1e;
  }

  .gloss-btn.active {
    background: #eab308;
    color: #1c1c1e;
  }

  .gloss-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* 句 button: same box as 段/句/词/音, blue text instead of the amber mode
     treatment. The extra classes keep it blue through the shared hover rule. */
  .btn.gloss-btn.sentence-all-btn {
    color: #0891b2;
  }

  .btn.gloss-btn.sentence-all-btn:hover:not(:disabled) {
    color: #0891b2;
    background: rgba(8, 145, 178, 0.1);
  }

  :global(html.dark) .btn.gloss-btn.sentence-all-btn {
    color: #22b8d4;
  }

  :global(html.dark) .btn.gloss-btn.sentence-all-btn:hover:not(:disabled) {
    color: #22b8d4;
    background: rgba(34, 184, 212, 0.16);
  }

  /* The pin shares the 词 group's amber active state but holds only an icon. */
  .gloss-pin-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 7px;
  }

  /* 8/23 progress inside the 段 button. */
  .paras-progress {
    margin-left: 4px;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }

  /* 对比提交 shares the 词 metrics but keeps a neutral idle look, because the
     amber highlight is reserved for an enabled reading mode. */
  .score-btn {
    padding: 4px 9px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #3a3a3c;
    background: transparent;
  }

  .score-btn:hover:not(.inactive):not(.scoring) {
    background: #f2f2f7;
    color: #1c1c1e;
  }

  .score-btn.inactive {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .score-btn.scoring {
    color: #0891b2;
  }

  :global(html.dark) .score-btn {
    color: #aeaeb2;
  }

  :global(html.dark) .score-btn:hover:not(.inactive):not(.scoring) {
    background: #2c2c2e;
    color: #e5e5e7;
  }

  :global(html.dark) .score-btn.scoring {
    color: #22d3ee;
  }

  :global(html.dark) .gloss-btn {
    color: #aeaeb2;
  }

  :global(html.dark) .gloss-btn:hover:not(:disabled):not(.active) {
    background: #2c2c2e;
    color: #e5e5e7;
  }

  :global(html.dark) .gloss-btn.active {
    background: #eab308;
    color: #1c1c1e;
  }

  .btn-group {
    display: flex;
    gap: 1px;
    background: #e5e5e5;
    border-radius: 7px;
    overflow: hidden;
    flex-shrink: 0;
  }

  :global(html.dark) .btn-group {
    background: #2c2c2e;
  }

  .btn {
    font-size: 12px;
    font-weight: 500;
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }

  .btn-primary {
    padding: 5px 14px;
    background: #0891B2;
    color: white;
    border-radius: 0;
  }

  .btn-primary:hover {
    background: #0E7490;
  }

  .btn-ghost {
    padding: 5px 14px;
    background: #f2f2f7;
    color: #3a3a3c;
  }

  :global(html.dark) .btn-ghost {
    background: #1c1c1e;
    color: #aeaeb2;
  }

  .btn-ghost:hover {
    background: #e5e5ea;
  }

  :global(html.dark) .btn-ghost:hover {
    background: #2c2c2e;
  }

  .btn-icon {
    padding: 5px 10px;
    background: transparent;
    color: #1c1c1e;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
  }

  :global(html.dark) .btn-icon {
    color: #e5e5e7;
  }

  .btn-icon:hover:not(:disabled):not(.active) {
    background: #f2f2f7;
    color: #000000;
  }

  :global(html.dark) .btn-icon:hover:not(:disabled):not(.active) {
    background: #2c2c2e;
    color: #ffffff;
  }

  .btn-icon.active:hover:not(:disabled) {
    background: #d4eef3;
  }

  :global(html.dark) .btn-icon.active:hover:not(:disabled) {
    background: #14304a;
  }

  .btn-icon:disabled {
    opacity: 0.22;
    cursor: not-allowed;
  }

  :global(html.dark) .btn-icon:disabled {
    opacity: 0.28;
  }

  .btn-icon.active {
    background: #E5F5F8;
    color: #0891B2;
  }

  :global(html.dark) .btn-icon.active {
    background: #0A1E2E;
    color: #22D3EE;
  }

  /* Document heading: the only compressible element in the left group. It
     ellipsizes with a full-name tooltip, then collapses to zero width, so the
     buttons on both sides keep their full size. */
  .current-heading {
    flex: 1 1 auto;
    min-width: 0;
    padding-right: 8px;
    font-size: 11px;
    color: #aeaeb2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .separator {
    width: 1px;
    height: 18px;
    background: #d1d1d6;
    margin: 0 4px;
  }

  :global(html.dark) .separator {
    background: #3a3a3c;
  }

  /* 左/右 cover toggles: a compact pair at the head of the right cluster. */
  .conceal-group {
    display: inline-flex;
    align-items: stretch;
    height: 28px;
    padding: 2px;
    gap: 2px;
    background: #e8e8ed;
    border-radius: 7px;
    flex-shrink: 0;
    margin-right: 4px;
  }

  :global(html.dark) .conceal-group {
    background: #2c2c2e;
  }

  .conceal-btn {
    border: none;
    background: transparent;
    color: #5f6368;
    font-size: 12px;
    font-weight: 500;
    padding: 0 7px;
    border-radius: 5px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  .conceal-btn:hover:not(:disabled):not(.active) {
    color: #1c1c1e;
  }

  :global(html.dark) .conceal-btn:hover:not(:disabled):not(.active) {
    color: #e5e5e7;
  }

  .conceal-btn.active {
    background: #eab308;
    color: #1c1c1e;
  }

  .conceal-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* View / Split / Edit segmented control */
  .mode-segmented {
    display: inline-flex;
    align-items: stretch;
    height: 28px;
    padding: 2px;
    gap: 2px;
    background: #e8e8ed;
    border-radius: 7px;
    flex-shrink: 0;
    margin-right: 4px;
  }

  :global(html.dark) .mode-segmented {
    background: #2c2c2e;
  }

  .mode-seg {
    border: none;
    background: transparent;
    color: #5f6368;
    font-size: 12px;
    font-weight: 500;
    padding: 0 10px;
    border-radius: 5px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  .mode-seg:hover:not(:disabled):not(.active) {
    color: #1c1c1e;
  }

  :global(html.dark) .mode-seg:hover:not(:disabled):not(.active) {
    color: #e5e5e7;
  }

  .mode-seg.active {
    background: #ffffff;
    color: #0891b2;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }

  :global(html.dark) .mode-seg.active {
    background: #48484a;
    color: #22d3ee;
  }

  .mode-seg:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .dropdown {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    width: 200px;
    background: white;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06);
    z-index: 50;
    padding: 4px;
    overflow: hidden;
  }

  :global(html.dark) .dropdown {
    background: #2c2c2e;
    border-color: #3a3a3c;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 7px 10px;
    font-size: 12px;
    color: #1c1c1e;
    background: none;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    text-align: left;
  }

  :global(html.dark) .dropdown-item {
    color: #e5e5e7;
  }

  .dropdown-item:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .dropdown-item:hover {
    background: #3a3a3c;
  }

  .dropdown-hint {
    font-size: 11px;
    color: #aeaeb2;
  }

  .save-btn {
    position: relative;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .save-btn.dirty {
    color: #0891B2;
  }

  :global(html.dark) .save-btn.dirty {
    color: #22D3EE;
  }

  .dirty-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #0891B2;
  }

  :global(html.dark) .dirty-dot {
    background: #22D3EE;
  }

  /* Narrow widths: the right cluster is ~1010px of full-size buttons and never
     shrinks, so the left group gives ground in this order. Thresholds are the
     exact points where the remaining left content stops fitting next to the
     right cluster (24px toolbar padding + ~1010px right group; the 左/右 pair
     adds ~62px to the old 948px cluster).
       1356px  heading needs >=60px to be readable, below that it is hidden
       1296px  logo + wordmark + open/paste/url + heading
       1295px  drop the wordmark          -> 188px left content
       1222px  drop the open/paste/url group -> 26px left content
       1072px  tighten right gaps/separators -> right group ~930px
       1060px  drop the left group entirely
     Below ~954px the right cluster alone no longer fits; see the report. */
  @media (max-width: 1355px) {
    .current-heading {
      display: none;
    }
  }

  @media (max-width: 1295px) {
    .toolbar-wordmark {
      display: none;
    }
  }

  @media (max-width: 1221px) {
    .toolbar-left .btn-group {
      display: none;
    }
  }

  @media (max-width: 1071px) {
    .toolbar-right {
      gap: 0;
    }

    .toolbar-right .separator {
      display: none;
    }

    .mode-segmented {
      margin-right: 0;
    }

    .conceal-group {
      margin-right: 0;
    }
  }

  /* The 左/右 pair adds ~62px to the right cluster, so the left group yields
     ~62px earlier than before. */
  @media (max-width: 1059px) {
    .toolbar-left {
      display: none;
    }
  }

  @media print {
    .toolbar { display: none !important; }
  }
</style>
