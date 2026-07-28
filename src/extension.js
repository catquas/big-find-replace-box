const vscode = require('vscode');

const VIEW_ID = 'vimBigCmdline.view';
const MAX_DECORATIONS = 1000;

/** @type {BigCmdlineProvider | undefined} */
let provider;

function activate(context) {
  provider = new BigCmdlineProvider(context.extensionUri);

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
    vscode.commands.registerCommand('vimBigCmdline.hide', () => {
      provider.hide();
      provider.clearPreview();
    })
  );
}

function deactivate() {
  provider?.dispose();
}

class BigCmdlineProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
    this.pendingPrefix = ':';
    this.searchDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
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
          if (this.pendingPrefix) {
            this.show(this.pendingPrefix);
          }
          break;
        case 'submit':
          await this.submit(message.prefix, message.value || '');
          break;
        case 'input':
          this.updatePreview(message.prefix, message.value || '');
          break;
        case 'cancel':
          this.hide();
          this.clearPreview();
          await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
          break;
      }
    });

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vimBigCmdline')) {
        this.sendConfiguration();
      }
    });
  }

  async open(prefix) {
    this.pendingPrefix = prefix;
    await focusCmdlineView();
    this.show(prefix);
  }

  show(prefix) {
    this.pendingPrefix = prefix;
    this.clearPreview();
    this.view?.show?.(true);
    this.view?.webview.postMessage({ type: 'show', prefix });
  }

  hide() {
    this.view?.webview.postMessage({ type: 'hide' });
  }

  clearPreview() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    editor.setDecorations(this.searchDecoration, []);
    editor.setDecorations(this.currentSearchDecoration, []);
    editor.setDecorations(this.substituteDecoration, []);
    editor.setDecorations(this.substituteAfterDecoration, []);
  }

  updatePreview(prefix, rawValue) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const value = String(rawValue);
    this.clearPreview();
    if (!value) {
      return;
    }

    if (prefix === '/' || prefix === '?') {
      this.previewSearch(editor, value, prefix === '?');
      return;
    }

    const parsed = parseSubstitute(value);
    if (parsed?.pattern) {
      this.previewSubstitute(editor, parsed);
    }
  }

  previewSearch(editor, pattern, reverse) {
    const regex = compileVimishRegex(pattern);
    if (!regex) {
      return;
    }

    const ranges = findMatches(editor.document, regex, fullDocumentRange(editor.document));
    editor.setDecorations(this.searchDecoration, ranges.slice(1));

    const current = chooseCurrentSearchMatch(ranges, editor.selection.active, reverse);
    if (current) {
      editor.setDecorations(this.currentSearchDecoration, [current]);
      editor.revealRange(current, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  previewSubstitute(editor, parsed) {
    const regex = compileVimishRegex(parsed.pattern);
    if (!regex) {
      return;
    }

    const searchRange = resolveSubstituteRange(editor, parsed.range);
    const matches = findMatches(editor.document, regex, searchRange, parsed.flags.includes('g') ? Infinity : 1);
    const replaceDecorations = [];
    const afterDecorations = [];

    for (const range of matches) {
      const text = editor.document.getText(range);
      const replacement = expandReplacement(parsed.replacement, text, regex);
      replaceDecorations.push(range);
      afterDecorations.push({
        range,
        renderOptions: {
          after: {
            contentText: `-> ${replacement}`,
          },
        },
      });
    }

    editor.setDecorations(this.substituteDecoration, replaceDecorations);
    editor.setDecorations(this.substituteAfterDecoration, afterDecorations);
  }

  sendConfiguration() {
    const config = vscode.workspace.getConfiguration('vimBigCmdline');
    this.view?.webview.postMessage({
      type: 'config',
      fontSize: config.get('fontSize', 30),
      fontFamily: config.get('fontFamily', 'var(--vscode-editor-font-family)'),
      panelHeightHint: config.get('panelHeightHint', 96),
    });
  }

  async submit(prefix, rawValue) {
    const value = String(rawValue);
    this.hide();
    this.clearPreview();
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');

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
      --cmd-font-size: 30px;
      --cmd-font-family: var(--vscode-editor-font-family);
      --cmd-height: 96px;
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
      align-items: center;
      min-height: var(--cmd-height);
      padding: 10px 14px;
      border-top: 1px solid var(--vscode-panel-border);
      font-family: var(--cmd-font-family);
    }
    .shell {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 10px;
      width: 100%;
    }
    .prefix {
      color: var(--vscode-terminal-ansiBrightCyan);
      font-size: calc(var(--cmd-font-size) * 1.12);
      font-weight: 800;
      line-height: 1;
    }
    .input-wrap {
      position: relative;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 8px;
      background: var(--vscode-input-background);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.02) inset;
    }
    #mirror, #cmdline {
      width: 100%;
      min-height: calc(var(--cmd-font-size) * 1.75);
      padding: 10px 12px;
      border: 0;
      font-family: var(--cmd-font-family);
      font-size: var(--cmd-font-size);
      font-weight: 650;
      line-height: 1.35;
      letter-spacing: 0.01em;
      white-space: pre-wrap;
      word-break: break-word;
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
    .hint {
      position: absolute;
      right: 8px;
      bottom: 3px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: 11px;
      font-weight: 400;
      opacity: 0.75;
    }
    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div id="prefix" class="prefix">:</div>
    <div class="input-wrap">
      <div id="mirror" aria-hidden="true"><span class="placeholder">Type a Vim command…</span></div>
      <textarea id="cmdline" rows="1" spellcheck="false" autocapitalize="none" autocomplete="off"></textarea>
      <div id="hint" class="hint">Enter to run · Esc to cancel</div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const prefixEl = document.getElementById('prefix');
    const input = document.getElementById('cmdline');
    const mirror = document.getElementById('mirror');
    let prefix = ':';

    window.addEventListener('message', event => {
      const message = event.data || {};
      if (message.type === 'show') {
        prefix = message.prefix || ':';
        prefixEl.textContent = prefix;
        input.value = prefix === ':' ? '' : '';
        render();
        requestAnimationFrame(() => input.focus());
      } else if (message.type === 'hide') {
        input.value = '';
        render();
      } else if (message.type === 'config') {
        document.documentElement.style.setProperty('--cmd-font-size', Number(message.fontSize || 30) + 'px');
        document.documentElement.style.setProperty('--cmd-font-family', message.fontFamily || 'var(--vscode-editor-font-family)');
        document.documentElement.style.setProperty('--cmd-height', Number(message.panelHeightHint || 96) + 'px');
      }
    });

    input.addEventListener('input', render);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        vscode.postMessage({ type: 'submit', prefix, value: input.value });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        vscode.postMessage({ type: 'cancel' });
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.slice(0, start) + '\\t' + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + 1;
        render();
      }
    });

    function render() {
      if (!input.value) {
        mirror.innerHTML = '<span class="placeholder">' + (prefix === ':' ? 'Type a Vim command…' : 'Type a search pattern…') + '</span>';
        vscode.postMessage({ type: 'input', prefix, value: input.value });
        return;
      }
      mirror.innerHTML = prefix === ':' ? highlightCommand(input.value) : highlightSearch(input.value);
      vscode.postMessage({ type: 'input', prefix, value: input.value });
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
        span('delimiter', parsed.delimiter),
        highlightReplacement(parsed.replacement),
        parsed.hasSecondDelimiter ? span('delimiter', parsed.delimiter) : '',
        span('flags', parsed.flags)
      ].join('');
    }

    function parseSubstitute(text) {
      const head = text.match(/^((?:%|\\d+|\\.|\\$|'[a-zA-Z]|[<>])?(?:,(?:%|\\d+|\\.|\\$|'[a-zA-Z]|[<>]))?)(s(?:ubstitute)?)(.)/);
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
    this.searchDecoration.dispose();
    this.currentSearchDecoration.dispose();
    this.substituteDecoration.dispose();
    this.substituteAfterDecoration.dispose();
  }
}

function parseSubstitute(text) {
  const head = text.match(/^((?:%|\d+|\.|\$|'[a-zA-Z]|[<>])?(?:,(?:%|\d+|\.|\$|'[a-zA-Z]|[<>]))?)(s(?:ubstitute)?)(.)/);
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

function compileVimishRegex(pattern) {
  try {
    return new RegExp(vimRegexToJavaScript(pattern), 'g');
  } catch {
    return undefined;
  }
}

function vimRegexToJavaScript(pattern) {
  return pattern
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\+/g, '+')
    .replace(/\\\?/g, '?')
    .replace(/\\\|/g, '|')
    .replace(/\\{/g, '{')
    .replace(/\\}/g, '}')
    .replace(/\\</g, '\\b')
    .replace(/\\>/g, '\\b');
}

function fullDocumentRange(document) {
  const lastLine = Math.max(0, document.lineCount - 1);
  return new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
}

function resolveSubstituteRange(editor, rangeText) {
  const document = editor.document;
  if (rangeText === '%') {
    return fullDocumentRange(document);
  }

  const lineNumberRange = rangeText.match(/^(\d+),(\d+)$/);
  if (lineNumberRange) {
    const start = clamp(Number(lineNumberRange[1]) - 1, 0, document.lineCount - 1);
    const end = clamp(Number(lineNumberRange[2]) - 1, start, document.lineCount - 1);
    return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
  }

  const singleLine = rangeText.match(/^\d+$/);
  if (singleLine) {
    const line = clamp(Number(singleLine[0]) - 1, 0, document.lineCount - 1);
    return new vscode.Range(line, 0, line, document.lineAt(line).text.length);
  }

  const activeLine = editor.selection.active.line;
  return new vscode.Range(activeLine, 0, activeLine, document.lineAt(activeLine).text.length);
}

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
      ranges.push(new vscode.Range(lineNumber, start, lineNumber, end));
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

function expandReplacement(replacement, matchedText, regex) {
  try {
    regex.lastIndex = 0;
    const jsReplacement = replacement.replace(/&/g, '$$&').replace(/\\(\d)/g, '$$$1');
    return matchedText.replace(regex, jsReplacement);
  } catch {
    return replacement;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function focusCmdlineView() {
  const commands = [
    `${VIEW_ID}.focus`,
    'workbench.view.extension.vimBigCmdline.container',
  ];

  for (const command of commands) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch {
      // Try the next VS Code view-focus command shape.
    }
  }

  vscode.window.showWarningMessage(
    'Vim Big Cmdline could not reveal its bottom panel. Open the "Vim Cmdline" panel manually once, then try again.'
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

module.exports = { activate, deactivate };
