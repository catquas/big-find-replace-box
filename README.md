# Vim Big Cmdline

This VS Code extension gives [VSCodeVim](https://github.com/VSCodeVim/Vim) a large command/search input in the bottom panel.

It intercepts `/`, `?`, and `:` while VSCodeVim is active and not in Insert mode, opens a large bottom input, previews matches while you type, and sends the completed input back to VSCodeVim through `vim.remap`.

For substitute commands such as:

```vim
:%s/foo\\(bar\\)\\+/baz/g
:s/[A-Z]\\+/word/g
```

the command line highlights the range, command, delimiters, search regex, replacement text, and flags with separate colors.

While you are typing a search or substitute pattern, the extension also decorates the editor:

- `/foo` and `?foo` highlight current matches in the whole file.
- `:s/foo` highlights matches on the current line as the regex is being built.
- `:%s/foo` highlights matches in the whole file as the regex is being built.
- `:s/foo/bar` and `:%s/foo/bar/g` add inline replacement-preview hints without editing the buffer.

## Running it locally

1. Open this folder in VS Code.
2. Make sure the `vscodevim.vim` extension is installed.
3. Press `F5` to launch an Extension Development Host.
4. In the Extension Development Host, open any file, enter VSCodeVim normal mode, then press `/`, `?`, or `:`.

## Settings

- `vimBigCmdline.fontSize`: default `30`
- `vimBigCmdline.fontFamily`: default `var(--vscode-editor-font-family)`
- `vimBigCmdline.panelHeightHint`: default `96`
- `vimBigCmdline.executeWithVscodeVimRemap`: default `true`

## Notes

VS Code extensions cannot directly enlarge another extension's status bar input, and VSCodeVim does not expose a full public API for mirroring its internal command-line buffer. This extension therefore replaces the command-line entry flow for the keys it owns, then hands the finished command/search back to VSCodeVim.

The live preview uses a JavaScript approximation of common Vim regex syntax. It understands useful Vim forms such as `\(`, `\)`, `\+`, `\?`, `\|`, word boundaries, `&` replacement, and `\1`-style capture references, but it is not a complete clone of VSCodeVim's internal regex engine.
