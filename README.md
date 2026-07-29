# Vim Big Cmdline

This VS Code extension gives [VSCodeVim](https://github.com/VSCodeVim/Vim) a large command/search input that takes over the sidebar.

It intercepts `/`, `?`, and `:` while VSCodeVim is active and not in Insert mode, opens a large input filling the sidebar, previews matches while you type, and sends the completed input back to VSCodeVim through `vim.remap`.

For substitute commands such as:

```vim
:%s/foo(bar)+/baz/g
:%s/("salary".*)/"salary"\1/
:s/[A-Z]+/word/g
```

the command line highlights the range, command, delimiters, search regex, replacement text, and flags with separate colors.

While you are typing a search or substitute pattern, the extension also decorates the editor:

- `/foo` and `?foo` highlight current matches in the whole file.
- `:s/foo` highlights matches on the current line as the regex is being built.
- `:%s/foo` highlights matches in the whole file as the regex is being built.
- `:s/foo/bar` and `:%s/foo/bar/g` add inline replacement-preview hints without editing the buffer.

A status line under the input reports what the pattern currently does — `12 matches · ignore case`, `4 replacements on 3 lines · whole file`, `No matches`, or `Invalid pattern`.

## Regex syntax: VSCodeVim's, not Vim's

VSCodeVim does not implement Vim's magic modes. Its pattern parser recognizes a short list of backslash escapes and hands everything else straight to JavaScript's `RegExp` ([`src/vimscript/pattern.ts`](https://github.com/VSCodeVim/Vim/blob/master/src/vimscript/pattern.ts)), so patterns behave like JavaScript regexes:

- `(` and `)` **group**, and `+`, `?`, `|`, `{n,m}` are quantifiers and alternation — no backslash needed. `:%s/("salary".*)/"salary"\1/` works.
- `\(`, `\+`, `\|` are **literal characters**, the opposite of Vim. Old Vim habits do not carry over, and neither does `\%(`.
- `\d`, `\w`, `\s`, `\b` and other JavaScript classes work as written.
- VSCodeVim's own escapes are translated: `\<` and `\>` become `\b`, `\n` becomes `\r?\n`, and `\x \X \o \h \H \a \A \l \L \u \U` become the matching character classes.
- A pattern that will not compile — `("salary"` while you are still typing it — is matched literally instead of erroring, the same fallback VSCodeVim uses. The status line says `incomplete, matching literally` when that happens.

Case follows VSCodeVim too:

- `vim.ignorecase` (default `true`) makes matching case-insensitive.
- `vim.smartcase` (default `true`) makes a pattern case-sensitive as soon as it contains an uppercase letter. VSCodeVim tests this against the *translated* pattern, so `foo\S` counts as uppercase and turns matching case-sensitive — real Vim would not. The preview copies VSCodeVim.
- `\c` and `\C` anywhere in the pattern force ignore-case / match-case and beat everything else; a `\c` wins over a `\C` wherever each appears.
- `:s///i` and `:s///I` do **nothing**. VSCodeVim parses those flags and never applies them, so the preview ignores them as well. Use `\c` or `\C`.
- `vimBigCmdline.caseSensitivity` can pin the preview to `ignore` or `match` regardless of the above.

In a replacement, `&` and `\0` are the whole match, `\1`–`\9` are capture groups, `\u` and `\l` change the case of the next character, `\U` and `\L` do so until `\e` or `\E`, and `\n`, `\t`, `\r`, `\&` and `\\` are literals — matching VSCodeVim's [`substitute.ts`](https://github.com/VSCodeVim/Vim/blob/master/src/cmd_line/commands/substitute.ts). `$` carries no special meaning.

Set `vimBigCmdline.regexFlavor` to `javascript` to skip the escape translation entirely and type raw JavaScript regexes.

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

Pressing `Enter` or `Esc` turns the command line off again. The view goes back to an idle note, and the sidebar — still open — goes back to showing the **Explorer**, so the command line shrinks to its icon in the activity bar rather than taking your sidebar down with it (`vimBigCmdline.restoreSidebarWhenDone`). If the view was already visible before you pressed a key, your sidebar is left exactly as it was.

`vimBigCmdline.restoreSidebarCommand` picks what you go back to: `workbench.view.scm`, `workbench.view.search`, or any other view command if you keep something else in the sidebar; `workbench.action.closeSidebar` if you would rather the sidebar closed; or empty to change nothing at all and leave the command line's own view on screen, idle.

VS Code gives extensions no way to collapse a view section, and no way to ask which view was in the sidebar a moment ago, which is why the destination is a setting rather than something the extension works out for itself.

The input box grows with your text and scrolls internally once it outgrows the sidebar, so a long substitute never gets clipped. `vimBigCmdline.panelHeightHint` sets a minimum height for it, and `vimBigCmdline.wrapLongInput` switches between wrapping and single-line horizontal scrolling.

The text is sized off your editor font (`vimBigCmdline.fontSize` = `0`), 15% larger, so it reads as slightly-enlarged editor text and a long substitute still fits on a line or two. Set `vimBigCmdline.fontSize` to a number of pixels to pin it instead.

## Running it locally

1. Open this folder in VS Code.
2. Make sure the `vscodevim.vim` extension is installed.
3. Press `F5` to launch an Extension Development Host.
4. In the Extension Development Host, open any file, enter VSCodeVim normal mode, then press `/`, `?`, or `:`.

## Settings

- `vimBigCmdline.fontSize`: default `0` (follow the editor font size, plus 15%)
- `vimBigCmdline.fontFamily`: default `var(--vscode-editor-font-family)`
- `vimBigCmdline.panelHeightHint`: default `120`
- `vimBigCmdline.wrapLongInput`: default `true`
- `vimBigCmdline.restoreSidebarWhenDone`: default `true`
- `vimBigCmdline.restoreSidebarCommand`: default `workbench.view.explorer`
- `vimBigCmdline.caseSensitivity`: `auto` (default), `ignore`, or `match`
- `vimBigCmdline.regexFlavor`: `vscodevim` (default) or `javascript`
- `vimBigCmdline.executeWithVscodeVimRemap`: default `true`

## Notes

VS Code extensions cannot directly enlarge another extension's status bar input, and VSCodeVim does not expose a full public API for mirroring its internal command-line buffer. This extension therefore replaces the command-line entry flow for the keys it owns, then hands the finished command/search back to VSCodeVim. VS Code also gives extensions no way to float a popup over the editor, so a view that fills the sidebar is the largest surface available.

VS Code does not tell extensions which view was showing in the sidebar before, and gives them no way to collapse a view section ([microsoft/vscode#88219](https://github.com/microsoft/vscode/issues/88219)), so where the sidebar goes afterwards is a setting rather than something the extension detects.

The live preview reimplements VSCodeVim's pattern translation rather than Vim's, because VSCodeVim is what executes the command — see [Regex syntax](#regex-syntax-vscodevims-not-vims) above. That includes its quirks: smartcase tested against the translated pattern, `:s///i` ignored, `\O` left untranslated because VSCodeVim's escape table lists `o` twice. The preview only ever describes what VSCodeVim will do; it never runs the command itself.
