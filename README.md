# Vim Big Cmdline

This VS Code extension gives [VSCodeVim](https://github.com/VSCodeVim/Vim) a large command/search input that takes over the sidebar.

It intercepts `/`, `?`, and `:` while VSCodeVim is active and not in Insert mode, opens a large input filling the sidebar, previews matches while you type, and sends the completed input back to VSCodeVim through `vim.remap`.

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

## Layout: it takes over the sidebar, then gives it back

Pressing `/`, `?`, or `:` reveals the **Vim Cmdline** view in the sidebar, and the input box fills the whole height of it — the extension does not move, resize, or reposition anything else in your layout.

Pressing `Enter` or `Esc` turns the command line off again. The view goes back to an idle note, and if opening the command line is what put the sidebar on screen, the sidebar is closed again so you end up where you started (`vimBigCmdline.restoreSidebarWhenDone`). If the view was already visible before you pressed a key, your sidebar is left exactly as it was.

If you keep something else in the sidebar — the Explorer, say — set `vimBigCmdline.restoreSidebarCommand` to `workbench.view.explorer` and that is what you return to instead. The same setting covers moving the "Vim Cmdline" view elsewhere: drag it into the bottom panel and set the command to `workbench.action.closePanel`.

The input box grows with your text and scrolls internally once it outgrows the sidebar, so a long substitute never gets clipped. `vimBigCmdline.panelHeightHint` sets a minimum height for it, and `vimBigCmdline.wrapLongInput` switches between wrapping and single-line horizontal scrolling.

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
- `vimBigCmdline.restoreSidebarWhenDone`: default `true`
- `vimBigCmdline.restoreSidebarCommand`: default `""` (hide the sidebar)
- `vimBigCmdline.caseSensitivity`: `auto` (default), `ignore`, or `match`
- `vimBigCmdline.regexFlavor`: `vim` (default) or `javascript`
- `vimBigCmdline.executeWithVscodeVimRemap`: default `true`

## Notes

VS Code extensions cannot directly enlarge another extension's status bar input, and VSCodeVim does not expose a full public API for mirroring its internal command-line buffer. This extension therefore replaces the command-line entry flow for the keys it owns, then hands the finished command/search back to VSCodeVim. VS Code also gives extensions no way to float a popup over the editor, so a view that fills the sidebar is the largest surface available.

VS Code does not tell extensions which sidebar container was showing before, which is why returning to something other than a hidden sidebar needs `vimBigCmdline.restoreSidebarCommand` rather than being detected automatically.

The live preview uses a JavaScript approximation of Vim regex syntax. By default it follows Vim's "magic" rules, where `( ) { } + ? |` are literal until escaped — so `\(`, `\)`, `\+`, `\?`, `\|`, `\{`, `\}`, `\%(`, `\=`, and `\<`/`\>` word boundaries all work, as do `&` and `\1`-style references in the replacement. Set `vimBigCmdline.regexFlavor` to `javascript` if you would rather type JavaScript regexes. Either way this only affects the preview: VSCodeVim executes the real command.
