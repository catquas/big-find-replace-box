const vscode = require('vscode');

const VIEW_ID = 'vimBigCmdline.view';
const MAX_DECORATIONS = 5000;
const HISTORY_LIMIT = 100;
const PREVIEW_DEBOUNCE_MS = 40;
const DEFAULT_RESTORE_COMMAND = 'workbench.view.explorer';
// 0 means "follow the editor font"; the webview turns that into a size derived
// from VS Code's own --vscode-editor-font-size.
const AUTO_FONT_SIZE = 0;
// The characters VSCodeVim escapes when a pattern will not compile.
const SPECIAL_CHARS = /[\-\[\]{}()*+?.,\\\^$|#\s]/g;
const HISTORY_KEYS = {
  search: 'vimBigCmdline.history.search',
  command: 'vimBigCmdline.history.command',
};

/** @type {BigCmdlineProvider | undefined} */
let provider;

function activate(context) {
  provider = new BigCmdlineProvider(context.extensionUri, context.globalState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('vimBigCmdline.search', async (args) => {
      await provider.open(args && args.reverse ? '?' : '/');
    }),
    vscode.commands.registerCommand('vimBigCmdline.command', async () => {
      await provider.open(':');
    }),
    vscode.commands.registerCommand('vimBigCmdline.hide', async () => {
      await provider.finish();
    }),
    vscode.commands.registerCommand('vimBigCmdline.clearHistory', async () => {
      await provider.clearHistory();
      vscode.window.showInformationMessage('Vim Big Cmdline history cleared.');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vimBigCmdline') || event.affectsConfiguration('vim')) {
        provider.sendConfiguration();
      }
    })
  );
}

function deactivate() {
  provider?.dispose();
}

class BigCmdlineProvider {
  constructor(extensionUri, memento) {
    this.extensionUri = extensionUri;
    this.memento = memento;
    this.view = undefined;
    this.pendingPrefix = ':';
    this.previewTimer = undefined;
    this.decoratedEditor = undefined;
    this.active = false;
    this.revealedView = false;
    this.warnedRestoreFailure = false;
    this.searchDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    this.currentSearchDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    });
    this.substituteDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
      textDecoration: 'line-through',
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editor.wordHighlightBorder'),
    });
    this.substituteAfterDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 0.6em',
        color: new vscode.ThemeColor('editorInlayHint.foreground'),
        backgroundColor: new vscode.ThemeColor('editorInlayHint.background'),
        fontStyle: 'normal',
        fontWeight: 'bold',
      },
    });
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.sendConfiguration();
          // Only take over the sidebar if the command line is actually in use;
          // a view opened by hand stays in its idle state until it is asked for.
          if (this.active) {
            this.show(this.pendingPrefix);
          } else {
            this.hide();
          }
          break;
        case 'activate':
          this.revealedView = false;
          this.show(message.prefix === '/' || message.prefix === '?' ? message.prefix : ':');
          break;
        case 'submit':
          await this.submit(message.prefix, message.value || '');
          break;
        case 'input':
          this.schedulePreview(message.prefix, message.value || '');
          break;
        case 'cancel':
          await this.finish();
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        // The sidebar was switched away from or closed: the command line is no
        // longer in use, so turn it off rather than leaving a live preview and
        // a half-typed command behind.
        this.hide();
        this.clearPreview();
      }
    });
  }

  async open(prefix) {
    this.pendingPrefix = prefix;
    this.active = true;
    // Remember whether revealing the command line is what put the sidebar on
    // screen, so that finishing can put the sidebar back the way it was without
    // closing one the user had deliberately open.
    this.revealedView = !this.view?.visible;
    await focusCmdlineView();
    this.show(prefix);
  }

  /**
   * Leave the command line: turn the input off, drop the preview, put the
   * sidebar back the way it was, and hand focus back to the editor.
   */
  async finish() {
    this.hide();
    this.clearPreview();
    await this.restoreSidebar();
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  /**
   * Undo the reveal from `open`. The command line gets out of the way by handing
   * the sidebar back to the view the user keeps there, so it shrinks to its
   * activity bar icon rather than taking the sidebar down with it. We only do
   * this when opening the command line is what revealed the view; if it was
   * already on screen, the user's layout is left alone.
   */
  async restoreSidebar() {
    const revealed = this.revealedView;
    this.revealedView = false;

    const config = vscode.workspace.getConfiguration('vimBigCmdline');
    if (!revealed || !config.get('restoreSidebarWhenDone', true)) {
      return;
    }

    const command = String(config.get('restoreSidebarCommand', DEFAULT_RESTORE_COMMAND) || '').trim();
    if (!command || (await runCommandQuietly(command))) {
      return;
    }

    // A misspelled command would otherwise fail silently on every Esc, so say
    // so once and then stay quiet for the rest of the session.
    if (!this.warnedRestoreFailure) {
      this.warnedRestoreFailure = true;
      vscode.window.showWarningMessage(
        `Vim Big Cmdline could not run "${command}" to put the sidebar back. ` +
          'Check vimBigCmdline.restoreSidebarCommand.'
      );
    }
  }

  show(prefix) {
    this.pendingPrefix = prefix;
    this.active = true;
    this.clearPreview();
    this.view?.show?.(true);
    this.view?.webview.postMessage({
      type: 'show',
      prefix,
      history: this.history(prefix),
    });
  }

  hide() {
    this.active = false;
    this.cancelScheduledPreview();
    this.view?.webview.postMessage({ type: 'hide' });
  }

  history(prefix) {
    return this.memento.get(HISTORY_KEYS[prefix === ':' ? 'command' : 'search'], []);
  }

  async pushHistory(prefix, value) {
    if (!value.trim()) {
      return;
    }
    const key = HISTORY_KEYS[prefix === ':' ? 'command' : 'search'];
    const entries = this.memento.get(key, []).filter((entry) => entry !== value);
    entries.push(value);
    await this.memento.update(key, entries.slice(-HISTORY_LIMIT));
  }

  async clearHistory() {
    await this.memento.update(HISTORY_KEYS.search, []);
    await this.memento.update(HISTORY_KEYS.command, []);
  }

  cancelScheduledPreview() {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }
  }

  schedulePreview(prefix, value) {
    this.cancelScheduledPreview();
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      this.updatePreview(prefix, value);
    }, PREVIEW_DEBOUNCE_MS);
  }

  clearPreview() {
    // Decorations live on the editor they were applied to, which may no longer
    // be the active one by the time we clear them.
    const editors = new Set([this.decoratedEditor, vscode.window.activeTextEditor]);
    for (const editor of editors) {
      if (!editor) {
        continue;
      }
      editor.setDecorations(this.searchDecoration, []);
      editor.setDecorations(this.currentSearchDecoration, []);
      editor.setDecorations(this.substituteDecoration, []);
      editor.setDecorations(this.substituteAfterDecoration, []);
    }
    this.decoratedEditor = undefined;
  }

  setStatus(text, tone = 'neutral') {
    this.view?.webview.postMessage({ type: 'status', text, tone });
  }

  updatePreview(prefix, rawValue) {
    const editor = vscode.window.activeTextEditor;
    this.clearPreview();

    if (!editor) {
      this.setStatus('No active editor', 'warn');
      return;
    }

    const value = String(rawValue);
    if (!value) {
      this.setStatus('');
      return;
    }

    this.decoratedEditor = editor;

    if (prefix === '/' || prefix === '?') {
      this.previewSearch(editor, value, prefix === '?');
      return;
    }

    const parsed = parseSubstitute(value);
    if (!parsed || !parsed.pattern) {
      this.setStatus('');
      return;
    }
    this.previewSubstitute(editor, parsed);
  }

  previewSearch(editor, pattern, reverse) {
    const compiled = compilePattern(pattern, reverse ? '?' : '/');
    if (!compiled) {
      this.setStatus('Invalid pattern', 'error');
      return;
    }

    const ranges = findMatches(
      editor.document,
      compiled.regex,
      fullDocumentRange(editor.document)
    ).map((match) => match.range);
    if (ranges.length === 0) {
      this.setStatus(`No matches${caseSuffix(compiled)}`, 'warn');
      return;
    }

    const current = chooseCurrentSearchMatch(ranges, editor.selection.active, reverse);
    editor.setDecorations(
      this.searchDecoration,
      current ? ranges.filter((range) => !range.isEqual(current)) : ranges
    );

    if (current) {
      editor.setDecorations(this.currentSearchDecoration, [current]);
      editor.revealRange(current, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    const capped = ranges.length >= MAX_DECORATIONS ? '+' : '';
    this.setStatus(`${ranges.length}${capped} ${plural(ranges.length, 'match', 'matches')}${caseSuffix(compiled)}`, 'ok');
  }

  previewSubstitute(editor, parsed) {
    // No case handling for the :s///i and :s///I flags: VSCodeVim parses them
    // and then never applies them, so honoring them here would show a preview
    // of something that is not going to happen.
    const compiled = compilePattern(parsed.pattern, parsed.delimiter);
    if (!compiled) {
      this.setStatus('Invalid pattern', 'error');
      return;
    }

    const searchRange = resolveSubstituteRange(editor, parsed.range);
    if (!searchRange) {
      this.setStatus('Invalid range', 'error');
      return;
    }

    const global = parsed.flags.includes('g');
    const matches = findMatches(editor.document, compiled.regex, searchRange, global ? Infinity : 1);
    const replaceDecorations = [];
    const afterDecorations = [];
    const touchedLines = new Set();

    for (const { range, groups } of matches) {
      const replacement = expandReplacement(parsed.replacement, groups);
      replaceDecorations.push(range);
      touchedLines.add(range.start.line);
      afterDecorations.push({
        range,
        renderOptions: {
          after: {
            contentText: replacement ? `→ ${replacement}` : '→ ∅',
          },
        },
      });
    }

    editor.setDecorations(this.substituteDecoration, replaceDecorations);
    editor.setDecorations(this.substituteAfterDecoration, afterDecorations);

    if (matches.length === 0) {
      this.setStatus(`No matches${caseSuffix(compiled)}`, 'warn');
      return;
    }

    editor.revealRange(matches[0].range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const capped = matches.length >= MAX_DECORATIONS ? '+' : '';
    const scope = describeRange(parsed.range);
    this.setStatus(
      `${matches.length}${capped} ${plural(matches.length, 'replacement', 'replacements')} on ` +
        `${touchedLines.size} ${plural(touchedLines.size, 'line', 'lines')}${scope}${caseSuffix(compiled)}`,
      'ok'
    );
  }

  sendConfiguration() {
    const config = vscode.workspace.getConfiguration('vimBigCmdline');
    this.view?.webview.postMessage({
      type: 'config',
      fontSize: config.get('fontSize', AUTO_FONT_SIZE),
      fontFamily: config.get('fontFamily', 'var(--vscode-editor-font-family)'),
      panelHeightHint: config.get('panelHeightHint', 120),
      wrap: config.get('wrapLongInput', true),
    });
  }

  async submit(prefix, rawValue) {
    const value = String(rawValue);
    await this.pushHistory(prefix, value);
    await this.finish();

    if (!vscode.workspace.getConfiguration('vimBigCmdline').get('executeWithVscodeVimRemap', true)) {
      return;
    }

    const sequence = [prefix, ...splitToVimKeys(value), '<CR>'];
    try {
      await vscode.commands.executeCommand('vim.remap', { after: sequence });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Vim Big Cmdline could not send input to VSCodeVim: ${detail}`);
    }
  }

  html(webview) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vim Big Cmdline</title>
  <style>
    :root {
      /* Editor text, a little larger — not a display font. Following VS Code's
         own editor font size keeps the gap the same whatever it is set to. */
      --cmd-font-size: calc(var(--vscode-editor-font-size, 14px) * 1.15);
      --cmd-font-family: var(--vscode-editor-font-family);
      --cmd-min-height: 120px;
      --cmd-wrap: pre-wrap;
      --cmd-break: break-word;
    }
    html, body {
      box-sizing: border-box;
      height: 100%;
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      overflow: hidden;
    }
    *, *::before, *::after {
      box-sizing: inherit;
    }
    body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 12px;
      font-family: var(--cmd-font-family);
    }
    .shell {
      display: flex;
      align-items: stretch;
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
    }
    /* The prefix sits right against the text, at the same size and line height
       so the two share a baseline: ":%s/foo/bar" reads as one line, and none of
       the width goes to a gap. */
    .prefix {
      flex: 0 0 auto;
      padding-top: 8px;
      color: var(--vscode-terminal-ansiBrightCyan);
      font-size: var(--cmd-font-size);
      font-weight: 800;
      line-height: 1.35;
    }
    /* The input area takes the whole height the sidebar gives us, and only
       starts scrolling once the text outgrows even that. */
    .input-scroll {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 8px;
      background: var(--vscode-input-background);
    }
    /* The mirror is in flow and sizes this box, so the box (and the textarea
       stretched over it) grows with the text instead of clipping it. */
    .input-wrap {
      position: relative;
      flex: 1 0 auto;
      min-width: 0;
      min-height: var(--cmd-min-height);
    }
    #mirror, #cmdline {
      display: block;
      width: 100%;
      min-height: calc(var(--cmd-font-size) * 1.75);
      margin: 0;
      padding: 8px 6px 8px 3px;
      border: 0;
      font-family: var(--cmd-font-family);
      font-size: var(--cmd-font-size);
      font-weight: 650;
      line-height: 1.35;
      /* No extra tracking: every fraction of a pixel per character is a
         character less on the line. */
      letter-spacing: normal;
      white-space: var(--cmd-wrap);
      word-break: var(--cmd-break);
      overflow-wrap: var(--cmd-break);
      tab-size: 4;
    }
    #mirror {
      pointer-events: none;
      color: var(--vscode-input-foreground);
    }
    #cmdline {
      position: absolute;
      inset: 0;
      resize: none;
      outline: none;
      overflow: hidden;
      background: transparent;
      color: transparent;
      caret-color: var(--vscode-input-foreground);
    }
    #cmdline::selection {
      background: var(--vscode-editor-selectionBackground);
      color: transparent;
    }
    .placeholder {
      opacity: 0.55;
    }
    .range { color: var(--vscode-terminal-ansiBrightBlack); }
    .command { color: var(--vscode-terminal-ansiBrightBlue); }
    .delimiter { color: var(--vscode-terminal-ansiYellow); }
    .pattern { color: var(--vscode-terminal-ansiBrightMagenta); }
    .replacement { color: var(--vscode-terminal-ansiBrightGreen); }
    .flags { color: var(--vscode-terminal-ansiBrightCyan); }
    .escape { color: var(--vscode-terminal-ansiRed); font-weight: 800; }
    .class { color: var(--vscode-terminal-ansiBlue); }
    .group { color: var(--vscode-terminal-ansiBrightYellow); }
    .quantifier { color: var(--vscode-terminal-ansiBrightRed); }
    .statusbar {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      flex: 0 0 auto;
      font-family: var(--vscode-font-family);
      font-size: 11px;
      line-height: 1.4;
    }
    #status {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    #status.ok { color: var(--vscode-terminal-ansiBrightGreen); }
    #status.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-terminal-ansiYellow)); }
    #status.error { color: var(--vscode-errorForeground); }
    #status.neutral { color: var(--vscode-descriptionForeground); }
    .hint {
      flex: 0 0 auto;
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
      white-space: nowrap;
    }
    @media (max-width: 640px) {
      .hint { display: none; }
    }
    /* Turned off: the command line gets out of the way and leaves the view
       empty apart from a note saying how to bring it back. */
    #idle {
      display: none;
      flex: 1 1 auto;
      align-items: center;
      justify-content: center;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      line-height: 1.6;
      text-align: center;
      cursor: pointer;
    }
    body.idle > .shell,
    body.idle > .statusbar { display: none; }
    body.idle > #idle { display: flex; }
    body.idle { justify-content: center; }
  </style>
</head>
<body class="idle">
  <div class="shell">
    <div id="prefix" class="prefix">:</div>
    <div class="input-scroll" id="scroller">
      <div class="input-wrap">
        <div id="mirror" aria-hidden="true"><span class="placeholder">Type a Vim command…</span></div>
        <textarea id="cmdline" rows="1" spellcheck="false" autocapitalize="none" autocorrect="off" autocomplete="off"></textarea>
      </div>
    </div>
  </div>
  <div class="statusbar">
    <div id="status" class="neutral"></div>
    <div class="hint">Enter run · Shift+Enter newline · ↑↓ history · Esc cancel</div>
  </div>
  <div id="idle">Press <b>/</b>, <b>?</b>, or <b>:</b> in the editor to open the command line here, or click to start one.</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const prefixEl = document.getElementById('prefix');
    const input = document.getElementById('cmdline');
    const mirror = document.getElementById('mirror');
    const statusEl = document.getElementById('status');
    const scroller = document.getElementById('scroller');
    const idleEl = document.getElementById('idle');
    let prefix = ':';
    let history = [];
    let historyIndex = -1;
    let draft = '';

    window.addEventListener('message', event => {
      const message = event.data || {};
      if (message.type === 'show') {
        prefix = message.prefix || ':';
        prefixEl.textContent = prefix;
        history = Array.isArray(message.history) ? message.history : [];
        historyIndex = -1;
        draft = '';
        input.value = '';
        setStatus('', 'neutral');
        document.body.classList.remove('idle');
        render();
        requestAnimationFrame(() => input.focus());
      } else if (message.type === 'hide') {
        input.value = '';
        historyIndex = -1;
        draft = '';
        setStatus('', 'neutral');
        render(true);
        document.body.classList.add('idle');
        input.blur();
      } else if (message.type === 'status') {
        setStatus(message.text || '', message.tone || 'neutral');
      } else if (message.type === 'config') {
        const root = document.documentElement.style;
        const fontSize = Number(message.fontSize);
        root.setProperty(
          '--cmd-font-size',
          fontSize > 0 ? fontSize + 'px' : 'calc(var(--vscode-editor-font-size, 14px) * 1.15)'
        );
        root.setProperty('--cmd-font-family', message.fontFamily || 'var(--vscode-editor-font-family)');
        root.setProperty('--cmd-min-height', Number(message.panelHeightHint || 120) + 'px');
        root.setProperty('--cmd-wrap', message.wrap === false ? 'pre' : 'pre-wrap');
        root.setProperty('--cmd-break', message.wrap === false ? 'normal' : 'break-word');
      }
    });

    function setStatus(text, tone) {
      statusEl.textContent = text;
      statusEl.className = tone || 'neutral';
    }

    input.addEventListener('input', () => {
      historyIndex = -1;
      render();
    });

    idleEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'activate', prefix: ':' });
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        vscode.postMessage({ type: 'submit', prefix, value: input.value });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        vscode.postMessage({ type: 'cancel' });
      } else if (isHistoryKey(event, 'prev')) {
        if (navigateHistory(-1)) event.preventDefault();
      } else if (isHistoryKey(event, 'next')) {
        if (navigateHistory(1)) event.preventDefault();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        insertAtCaret('\\t');
      } else if (event.key === 'u' && event.ctrlKey) {
        event.preventDefault();
        input.value = input.value.slice(input.selectionStart);
        input.selectionStart = input.selectionEnd = 0;
        historyIndex = -1;
        render();
      } else if (event.key === 'w' && event.ctrlKey) {
        event.preventDefault();
        deleteWordBefore();
      }
    });

    function isHistoryKey(event, direction) {
      if (event.ctrlKey && event.key === (direction === 'prev' ? 'p' : 'n')) return true;
      if (event.altKey || event.metaKey || event.ctrlKey) return false;
      if (event.key !== (direction === 'prev' ? 'ArrowUp' : 'ArrowDown')) return false;
      // Shift+Enter can produce a multi-line command; leave the arrows alone
      // unless the caret is already on the first (or last) line.
      return direction === 'prev'
        ? !input.value.slice(0, input.selectionStart).includes('\\n')
        : !input.value.slice(input.selectionEnd).includes('\\n');
    }

    function navigateHistory(delta) {
      if (history.length === 0) return false;

      let next;
      if (historyIndex === -1) {
        if (delta > 0) return false;
        draft = input.value;
        next = history.length - 1;
      } else {
        next = historyIndex + delta;
        if (next < 0) return false;
        if (next >= history.length) next = -1;
      }

      historyIndex = next;
      input.value = historyIndex === -1 ? draft : history[historyIndex];
      input.selectionStart = input.selectionEnd = input.value.length;
      render();
      return true;
    }

    function insertAtCaret(text) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      input.selectionStart = input.selectionEnd = start + text.length;
      historyIndex = -1;
      render();
    }

    function deleteWordBefore() {
      const start = input.selectionStart;
      if (start === 0) return;
      const before = input.value.slice(0, start);
      const trimmed = before.replace(/\\s*\\S+$/, '');
      input.value = trimmed + input.value.slice(input.selectionEnd);
      input.selectionStart = input.selectionEnd = trimmed.length;
      historyIndex = -1;
      render();
    }

    function render(skipPreview) {
      if (!input.value) {
        mirror.innerHTML = '<span class="placeholder">' + (prefix === ':' ? 'Type a Vim command…' : 'Type a search pattern…') + '</span>';
      } else {
        mirror.innerHTML = prefix === ':' ? highlightCommand(input.value) : highlightSearch(input.value);
      }
      keepCaretVisible();
      if (!skipPreview) {
        vscode.postMessage({ type: 'input', prefix, value: input.value });
      }
    }

    function keepCaretVisible() {
      if (input.selectionStart === input.value.length) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    }

    function highlightCommand(text) {
      const parsed = parseSubstitute(text);
      if (!parsed) {
        return escapeHtml(text);
      }

      return [
        span('range', parsed.range),
        span('command', parsed.command),
        span('delimiter', parsed.delimiter),
        highlightRegex(parsed.pattern, 'pattern'),
        parsed.hasSecondDelimiter ? span('delimiter', parsed.delimiter) : '',
        highlightReplacement(parsed.replacement),
        parsed.hasThirdDelimiter ? span('delimiter', parsed.delimiter) : '',
        span('flags', parsed.flags)
      ].join('');
    }

    function parseSubstitute(text) {
      const head = text.match(/^((?:%|\\d+|\\.|\\$|'[a-zA-Z<>])(?:[+-]\\d*)?(?:,(?:%|\\d+|\\.|\\$|'[a-zA-Z<>])(?:[+-]\\d*)?)?)?(s(?:ubstitute)?)([^a-zA-Z0-9\\s\\\\"|])/);
      if (!head) return undefined;

      const range = head[1] || '';
      const command = head[2];
      const delimiter = head[3];
      const rest = text.slice(head[0].length);
      const first = readUntilDelimiter(rest, delimiter, 0);
      const second = readUntilDelimiter(rest, delimiter, first.nextIndex);

      return {
        range,
        command,
        delimiter,
        pattern: first.value,
        replacement: second.value,
        hasSecondDelimiter: first.found,
        hasThirdDelimiter: second.found,
        flags: second.found ? rest.slice(second.nextIndex) : '',
      };
    }

    function readUntilDelimiter(text, delimiter, start) {
      let value = '';
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\\\' && i + 1 < text.length) {
          value += ch + text[i + 1];
          i++;
          continue;
        }
        if (ch === delimiter) {
          return { value, nextIndex: i + 1, found: true };
        }
        value += ch;
      }
      return { value, nextIndex: text.length, found: false };
    }

    function highlightSearch(text) {
      return highlightRegex(text, 'pattern');
    }

    function highlightReplacement(text) {
      let out = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\\\' && i + 1 < text.length) {
          out += span('escape', text.slice(i, i + 2));
          i++;
        } else if (ch === '&') {
          out += span('escape', ch);
        } else {
          out += span('replacement', ch);
        }
      }
      return out;
    }

    function highlightRegex(text, baseClass) {
      let out = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\\\' && i + 1 < text.length) {
          out += span('escape', text.slice(i, i + 2));
          i++;
        } else if (ch === '[') {
          const end = findClassEnd(text, i + 1);
          if (end >= 0) {
            out += span('class', text.slice(i, end + 1));
            i = end;
          } else {
            out += span(baseClass, ch);
          }
        } else if ('()|'.includes(ch)) {
          out += span('group', ch);
        } else if ('*+?{}'.includes(ch)) {
          out += span('quantifier', ch);
        } else if (ch === '^' || ch === '$') {
          out += span('delimiter', ch);
        } else {
          out += span(baseClass, ch);
        }
      }
      return out;
    }

    function findClassEnd(text, start) {
      for (let i = start; i < text.length; i++) {
        if (text[i] === '\\\\') {
          i++;
        } else if (text[i] === ']') {
          return i;
        }
      }
      return -1;
    }

    function span(className, value) {
      if (!value) return '';
      return '<span class="' + className + '">' + escapeHtml(value) + '</span>';
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose() {
    this.cancelScheduledPreview();
    this.searchDecoration.dispose();
    this.currentSearchDecoration.dispose();
    this.substituteDecoration.dispose();
    this.substituteAfterDecoration.dispose();
  }
}

function parseSubstitute(text) {
  const head = text.match(
    /^((?:%|\d+|\.|\$|'[a-zA-Z<>])(?:[+-]\d*)?(?:,(?:%|\d+|\.|\$|'[a-zA-Z<>])(?:[+-]\d*)?)?)?(s(?:ubstitute)?)([^a-zA-Z0-9\s\\"|])/
  );
  if (!head) {
    return undefined;
  }

  const range = head[1] || '';
  const command = head[2];
  const delimiter = head[3];
  const rest = text.slice(head[0].length);
  const first = readUntilDelimiter(rest, delimiter, 0);
  const second = readUntilDelimiter(rest, delimiter, first.nextIndex);

  return {
    range,
    command,
    delimiter,
    pattern: first.value,
    replacement: second.value,
    hasSecondDelimiter: first.found,
    hasThirdDelimiter: second.found,
    flags: second.found ? rest.slice(second.nextIndex) : '',
  };
}

function readUntilDelimiter(text, delimiter, start) {
  let value = '';
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      value += char + text[i + 1];
      i++;
      continue;
    }
    if (char === delimiter) {
      return { value, nextIndex: i + 1, found: true };
    }
    value += char;
  }
  return { value, nextIndex: text.length, found: false };
}

/**
 * Compile a pattern the way VSCodeVim does, so the preview matches what will
 * actually run.
 *
 * VSCodeVim does not implement Vim's magic modes. Apart from a small table of
 * backslash escapes its parser hands the pattern straight to JavaScript's
 * RegExp (src/vimscript/pattern.ts), so `(` groups, `+` repeats and `|`
 * alternates without being escaped, and `\(` is a *literal* paren — the
 * opposite of Vim. Quirks included, because VSCodeVim is what runs the command.
 *
 * @returns {{ regex: RegExp, ignoreCase: boolean, override: 'insensitive'|'sensitive'|undefined, escaped: boolean } | undefined}
 */
function compilePattern(pattern, delimiter) {
  if (!pattern) {
    return undefined;
  }

  const flavor = vscode.workspace.getConfiguration('vimBigCmdline').get('regexFlavor', 'vscodevim');
  const { source, override } =
    flavor === 'javascript'
      ? { source: pattern, override: undefined }
      : vscodeVimPatternToJavaScript(pattern, delimiter);
  const ignoreCase = shouldIgnoreCase(source, override);
  const flags = ignoreCase ? 'gim' : 'gm';

  try {
    return { regex: new RegExp(source, flags), ignoreCase, override, escaped: false };
  } catch {
    // VSCodeVim's own fallback: a pattern that will not compile is retried with
    // every special character escaped, so a half-typed `(` still matches text
    // instead of reporting an error.
    try {
      const literal = source.replace(SPECIAL_CHARS, '\\$&');
      return { regex: new RegExp(literal, flags), ignoreCase, override, escaped: true };
    } catch {
      return undefined;
    }
  }
}

/**
 * VSCodeVim's escape table. Anything missing keeps its backslash, so `\d` and
 * friends stay JavaScript classes while `\(`, `\+` and `\|` come out literal.
 * `\O` is absent because VSCodeVim's own table lists 'o' twice and never
 * reaches it.
 */
const VSCODEVIM_ESCAPES = new Map(Object.entries({
  x: '[0-9A-Fa-f]',
  X: '[^0-9A-Fa-f]',
  o: '[0-7]',
  h: '[A-Za-z_]',
  H: '[^A-Za-z_]',
  a: '[A-Za-z]',
  A: '[^A-Za-z]',
  l: '[a-z]',
  L: '[^a-z]',
  u: '[A-Z]',
  U: '[^A-Z]',
  '<': '\\b',
  '>': '\\b',
  n: '\\r?\\n',
}));

/**
 * Translate a pattern to the JavaScript source VSCodeVim would build from it,
 * reporting any inline `\c` / `\C` separately since those are stripped from the
 * pattern rather than compiled into it.
 *
 * @returns {{ source: string, override: 'insensitive'|'sensitive'|undefined }}
 */
function vscodeVimPatternToJavaScript(pattern, delimiter) {
  let source = '';
  let override;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '\\') {
      const escaped = pattern[i + 1];
      i++;

      if (escaped === undefined) {
        source += '\\\\';
        break;
      }
      // \%V limits a search to the selection and adds nothing to the pattern.
      if (escaped === '%' && pattern[i + 1] === 'V') {
        i++;
        continue;
      }
      // A later \c still wins over an earlier \C, as in VSCodeVim.
      if (escaped === 'c') {
        override = 'insensitive';
        continue;
      }
      if (escaped === 'C') {
        override = override || 'sensitive';
        continue;
      }
      if (escaped === delimiter) {
        source += escaped;
        continue;
      }
      source += VSCODEVIM_ESCAPES.get(escaped) ?? '\\' + escaped;
      continue;
    }

    // Character classes are copied across untouched, escapes and all.
    if (char === '[') {
      const end = findCharacterClassEnd(pattern, i + 1);
      if (end >= 0) {
        source += pattern.slice(i, end + 1);
        i = end;
        continue;
      }
      source += char;
      continue;
    }

    // VSCodeVim wraps the anchors so \r\n does not read as two lines.
    if (char === '^') {
      source += '(?:^(?<!\\r))';
      continue;
    }
    if (char === '$') {
      source += '(?:$(?<!\\r))';
      continue;
    }

    source += char;
  }

  return { source, override };
}

function findCharacterClassEnd(pattern, start) {
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
    } else if (pattern[i] === ']') {
      return i;
    }
  }
  return -1;
}

/**
 * Case rules in VSCodeVim's order: an inline `\c` / `\C` wins, then this
 * extension's own pin, then smartcase, then vim.ignorecase.
 *
 * VSCodeVim tests smartcase with /[A-Z]/ against the *translated* pattern, so
 * `\S` counts as an uppercase letter and `\a` does too once it has become
 * [A-Za-z]. Real Vim skips escapes; this follows VSCodeVim.
 */
function shouldIgnoreCase(source, override) {
  if (override) {
    return override === 'insensitive';
  }

  const mode = vscode.workspace.getConfiguration('vimBigCmdline').get('caseSensitivity', 'auto');
  if (mode === 'ignore') {
    return true;
  }
  if (mode === 'match') {
    return false;
  }

  const vim = vscode.workspace.getConfiguration('vim');
  if (vim.get('smartcase', true) && /[A-Z]/.test(source)) {
    return false;
  }
  return vim.get('ignorecase', true);
}

function fullDocumentRange(document) {
  const lastLine = Math.max(0, document.lineCount - 1);
  return new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
}

function resolveSubstituteRange(editor, rangeText) {
  const document = editor.document;
  const spec = (rangeText || '').trim();

  if (spec === '%') {
    return fullDocumentRange(document);
  }

  if (!spec) {
    return lineRange(document, editor.selection.active.line);
  }

  const parts = spec.split(',');
  if (parts.length > 2) {
    return undefined;
  }

  const first = resolveLineSpec(editor, parts[0]);
  if (first === undefined) {
    return undefined;
  }
  const second = parts.length === 2 ? resolveLineSpec(editor, parts[1]) : first;
  if (second === undefined) {
    return undefined;
  }

  const start = Math.min(first, second);
  const end = Math.max(first, second);
  return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
}

/** Resolve a single Vim line address (`.`, `$`, `12`, `'<`, `.+3`) to a 0-based line. */
function resolveLineSpec(editor, spec) {
  const document = editor.document;
  const match = String(spec).trim().match(/^(%|\.|\$|\d+|'[a-zA-Z<>])?([+-]\d*)?$/);
  if (!match || (!match[1] && !match[2])) {
    return undefined;
  }

  const lastLine = document.lineCount - 1;
  let base;

  switch (match[1]) {
    case undefined:
    case '.':
      base = editor.selection.active.line;
      break;
    case '%':
      base = 0;
      break;
    case '$':
      base = lastLine;
      break;
    case "'<":
      base = editor.selection.start.line;
      break;
    case "'>":
      base = editor.selection.end.line;
      break;
    default:
      if (/^\d+$/.test(match[1])) {
        base = Number(match[1]) - 1;
      } else {
        // Unsupported mark: fall back to the cursor line rather than failing.
        base = editor.selection.active.line;
      }
      break;
  }

  if (match[2]) {
    const sign = match[2][0] === '-' ? -1 : 1;
    const amount = match[2].length > 1 ? Number(match[2].slice(1)) : 1;
    base += sign * amount;
  }

  return clamp(base, 0, lastLine);
}

function lineRange(document, line) {
  const safe = clamp(line, 0, document.lineCount - 1);
  return new vscode.Range(safe, 0, safe, document.lineAt(safe).text.length);
}

/**
 * Find matches line by line.
 *
 * @returns {{ range: vscode.Range, groups: (string|undefined)[] }[]} each match
 * with its capture groups, which the replacement preview needs.
 */
function findMatches(document, regex, searchRange, maxPerLine = Infinity) {
  const ranges = [];
  const startLine = searchRange.start.line;
  const endLine = searchRange.end.line;

  for (let lineNumber = startLine; lineNumber <= endLine && ranges.length < MAX_DECORATIONS; lineNumber++) {
    const line = document.lineAt(lineNumber);
    const lineStart = lineNumber === startLine ? searchRange.start.character : 0;
    const lineEnd = lineNumber === endLine ? searchRange.end.character : line.text.length;
    const text = line.text.slice(lineStart, lineEnd);
    const perLineLimit = Number.isFinite(maxPerLine) ? maxPerLine : MAX_DECORATIONS;
    let perLineCount = 0;
    regex.lastIndex = 0;

    for (let match; (match = regex.exec(text)) && ranges.length < MAX_DECORATIONS;) {
      if (match[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      if (perLineCount >= perLineLimit) {
        break;
      }
      const start = lineStart + match.index;
      const end = start + match[0].length;
      ranges.push({
        range: new vscode.Range(lineNumber, start, lineNumber, end),
        groups: Array.from(match),
      });
      perLineCount++;
    }
  }

  return ranges;
}

function chooseCurrentSearchMatch(ranges, position, reverse) {
  if (ranges.length === 0) {
    return undefined;
  }

  if (reverse) {
    return [...ranges].reverse().find((range) => range.start.isBefore(position)) || ranges[ranges.length - 1];
  }

  return ranges.find((range) => range.start.isAfter(position) || range.start.isEqual(position)) || ranges[0];
}

/** Literal escapes VSCodeVim recognizes in a replacement. */
const REPLACEMENT_LITERALS = new Map(Object.entries({
  '\\': '\\',
  '/': '/',
  b: '\b',
  r: '\r',
  n: '\n',
  t: '\t',
  '&': '&',
  '~': '~',
}));

/**
 * Expand a substitute replacement the way VSCodeVim does
 * (src/cmd_line/commands/substitute.ts): `&` and `\0` are the whole match,
 * `\1`-`\9` are capture groups, `\u` / `\l` change the case of the next
 * character and `\U` / `\L` do so until `\e` / `\E`.
 *
 * @param {(string|undefined)[]} groups the match and its capture groups
 */
function expandReplacement(replacement, groups) {
  let out = '';
  let run;
  let nextChar;

  const append = (text) => {
    for (const char of text) {
      if (nextChar) {
        out += nextChar === 'upper' ? char.toUpperCase() : char.toLowerCase();
        nextChar = undefined;
      } else if (run) {
        out += run === 'upper' ? char.toUpperCase() : char.toLowerCase();
      } else {
        out += char;
      }
    }
  };

  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i];

    if (char === '&') {
      append(groups[0] ?? '');
      continue;
    }
    if (char !== '\\') {
      append(char);
      continue;
    }

    const escaped = replacement[i + 1];
    i++;

    if (escaped === undefined) {
      append('\\');
      break;
    }
    if (REPLACEMENT_LITERALS.has(escaped)) {
      append(REPLACEMENT_LITERALS.get(escaped));
      continue;
    }
    if (escaped >= '0' && escaped <= '9') {
      append(groups[Number(escaped)] ?? '');
      continue;
    }
    if (escaped === 'u' || escaped === 'l') {
      nextChar = escaped === 'u' ? 'upper' : 'lower';
      continue;
    }
    if (escaped === 'U' || escaped === 'L') {
      run = escaped === 'U' ? 'upper' : 'lower';
      continue;
    }
    if (escaped === 'e' || escaped === 'E') {
      run = undefined;
      continue;
    }
    append('\\' + escaped);
  }

  return out;
}

function caseSuffix(compiled) {
  if (!compiled) {
    return '';
  }
  const forced = compiled.override ? ' (forced)' : '';
  // VSCodeVim falls back to matching the pattern literally when it will not
  // compile, which is worth saying out loud: it is why a half-typed group still
  // shows matches.
  const literal = compiled.escaped ? ' · incomplete, matching literally' : '';
  return (compiled.ignoreCase ? ` · ignore case${forced}` : ` · match case${forced}`) + literal;
}

function describeRange(rangeText) {
  const spec = (rangeText || '').trim();
  if (!spec) {
    return ' · current line';
  }
  if (spec === '%') {
    return ' · whole file';
  }
  return ` · ${spec}`;
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Run a workbench command, ignoring the failure if this VS Code build lacks it. */
async function runCommandQuietly(command) {
  try {
    await vscode.commands.executeCommand(command);
    return true;
  } catch {
    return false;
  }
}

async function focusCmdlineView() {
  const commands = [
    `${VIEW_ID}.focus`,
    'workbench.view.extension.vimBigCmdline.container',
  ];

  for (const command of commands) {
    if (await runCommandQuietly(command)) {
      return;
    }
  }

  vscode.window.showWarningMessage(
    'Vim Big Cmdline could not reveal its command line. If you hid the "Vim Cmdline" view, ' +
      'run "View: Reset View Locations" to restore it.'
  );
}

function splitToVimKeys(value) {
  return Array.from(value).map((char) => {
    switch (char) {
      case '\t':
        return '<Tab>';
      case '\n':
        return '<CR>';
      case ' ':
        return '<Space>';
      case '<':
        return '<lt>';
      default:
        return char;
    }
  });
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

module.exports = {
  activate,
  deactivate,
  // Exported for manual testing / reuse.
  parseSubstitute,
  vscodeVimPatternToJavaScript,
  expandReplacement,
};
