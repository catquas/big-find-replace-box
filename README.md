# Vim Big Cmdline

This VS Code extension gives [VSCodeVim](https://github.com/VSCodeVim/Vim) a large command/search input in the bottom panel.

It intercepts `/`, `?`, and `:` while VSCodeVim is active and not in Insert mode, opens a large bottom input, previews matches while you type, and sends the completed input back to VSCodeVim through `vim.remap`.

For substitute commands such as:

```vim
:%s/foo\(bar\)\+/baz/g
:s/[A-Z]\+/word/g
```

the command line highlights the range, command, delimiters, search regex, replacement text, and flags with separate colors.

While you are typing a search or substitute pattern, the extension also decorates the editor:

- `/foo` and `?foo` highlight current matches in the whole file.
- `:s/foo` highlights matches on the current line as the regex is being built.
- `:%s/foo` highlights matches in the whole file as the regex is being built.
- `:s/foo/bar` and `:%s/foo/bar/g` add inline replacement-preview hints without editing the buffer.

A status line under the input reports what the pattern currently does — `12 matches · ignore case`, `4 replacements on 3 lines · whole file`, `No matches`, or `Invalid pattern`.

## Case sensitivity

The preview follows VSCodeVim's own rules, so what you see is what VSCodeVim will do:

- `vim.ignorecase` (default `true`) makes matching case-insensitive.
- `vim.smartcase` (default `true`) makes a pattern case-sensitive as soon as it contains an uppercase letter. Backslash escapes do not count, so `foo\S` stays case-insensitive but `Foo` does not.
- `\c` and `\C` anywhere in the pattern force ignore-case / match-case and beat everything else.
- `:s///i` and `:s///I` force ignore-case / match-case for that substitution, unless `\c`/`\C` is also present.
- `vimBigCmdline.caseSensitivity` can pin the preview to `ignore` or `match` regardless of the above.

## Keys in the command line

| Key | Action |
| --- | --- |
| `Enter` | Run the command |
| `Shift+Enter` | Insert a newline (for long multi-line commands) |
| `Esc` | Cancel and return to the editor |
| `Up` / `Down`, `Ctrl+P` / `Ctrl+N` | Previous / next history entry |
| `Ctrl+W` | Delete the word before the cursor |
| `Ctrl+U` | Delete to the start of the line |
| `Tab` | Insert a literal tab |

History is kept separately for searches (`/`, `?`) and commands (`:`), persists across sessions, and can be wiped with **Vim Big Cmdline: Clear Command History**.

## Layout: a bar across the bottom of the screen

Pressing `/`, `?`, or `:` now does three things before showing the input:

1. Moves VS Code's panel to the **bottom** of the window, so the command line is a full-width bar across the bottom of the screen instead of a column beside the editor (`vimBigCmdline.forceBottomPanelPosition`).
2. **Enlarges** the panel so there is plenty of room to type, then shrinks it back to your normal size when you finish (`vimBigCmdline.panelSizeBoost`, or `vimBigCmdline.maximizePanelOnOpen` to take over the whole window).
3. Shows the bar only while it is in use — `Enter` or `Esc` closes the panel again (`vimBigCmdline.hidePanelWhenDone`).

Within that bar, the input box grows with your text and scrolls internally once it outgrows the panel, so a long substitute never gets clipped. `vimBigCmdline.panelHeightHint` sets the minimum height of the input box, and `vimBigCmdline.wrapLongInput` switches between wrapping and single-line horizontal scrolling.

VS Code gives extensions no way to float a truly standalone bar or popup over the editor — the panel is the only full-width bottom surface available to an extension — so the extension drives the panel to behave like one. If you previously dragged the "Vim Cmdline" view into a side bar, drag it back onto the panel, or run **View: Reset View Locations**.

## Running it locally

1. Open this folder in VS Code.
2. Make sure the `vscodevim.vim` extension is installed.
3. Press `F5` to launch an Extension Development Host.
4. In the Extension Development Host, open any file, enter VSCodeVim normal mode, then press `/`, `?`, or `:`.

## Settings

- `vimBigCmdline.fontSize`: default `30`
- `vimBigCmdline.fontFamily`: default `var(--vscode-editor-font-family)`
- `vimBigCmdline.panelHeightHint`: default `120`
- `vimBigCmdline.wrapLongInput`: default `true`
- `vimBigCmdline.forceBottomPanelPosition`: default `true`
- `vimBigCmdline.hidePanelWhenDone`: default `true`
- `vimBigCmdline.panelSizeBoost`: default `3`
- `vimBigCmdline.maximizePanelOnOpen`: default `false`
- `vimBigCmdline.caseSensitivity`: `auto` (default), `ignore`, or `match`
- `vimBigCmdline.regexFlavor`: `vim` (default) or `javascript`
- `vimBigCmdline.executeWithVscodeVimRemap`: default `true`

## Notes

VS Code extensions cannot directly enlarge another extension's status bar input, and VSCodeVim does not expose a full public API for mirroring its internal command-line buffer. This extension therefore replaces the command-line entry flow for the keys it owns, then hands the finished command/search back to VSCodeVim. VS Code also gives extensions no way to float a popup over the editor, so the bottom panel is the largest surface available.

The live preview uses a JavaScript approximation of Vim regex syntax. By default it follows Vim's "magic" rules, where `( ) { } + ? |` are literal until escaped — so `\(`, `\)`, `\+`, `\?`, `\|`, `\{`, `\}`, `\%(`, `\=`, and `\<`/`\>` word boundaries all work, as do `&` and `\1`-style references in the replacement. Set `vimBigCmdline.regexFlavor` to `javascript` if you would rather type JavaScript regexes. Either way this only affects the preview: VSCodeVim executes the real command.
