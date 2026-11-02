<!-- changes-log: packages/coding-agent/src/modes/interactive/changes.md -->
## 2026-11-02 - IME composition on the question list shows on the own-answer row, not the footer (senpi#4400)

### What changed

- `packages/coding-agent/src/modes/interactive/components/ask-user-question-render.ts`: `renderQuestionList(state, focused)` ends the `Type your own answer...` row with `CURSOR_MARKER` while the focused overlay has the option list focused, so the TUI parks the hardware cursor at the end of that row.
- `packages/coding-agent/src/modes/interactive/components/ask-user-question.ts`: passes its focus state to `renderQuestionList()` and rebuilds its rows when focus changes, so the marker appears and disappears with focus. The open own-answer editor and the comment editor keep their own cursor as before.

### Why

- On the option list no component emitted a cursor marker, so the hardware cursor stayed at the end of the last rendered line, the footer. macOS IMEs draw composing (preedit) text at the hardware cursor, so the first Korean syllable typed on the list showed next to the model display in the footer until the next syllable committed it and opened the answer input (senpi#4400, reported by cmj1203). A printable key on the list opens the own answer, so its row is where the typed text belongs.
- The hardware cursor stays hidden unless `showHardwareCursor` is on; only its position changes.

### Why an extension could not handle it

- The question overlay is the built-in `ctx.ui.question` component; its rows and cursor placement are rendered inside it.

### Expected merge conflict zones

- LOW: `renderQuestionList()` in `ask-user-question-render.ts`; the `focused` setter and the `renderQuestionList` call in `updateAll()` in `ask-user-question.ts`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- Typing Korean (or any IME composition) while a question's option list is focused now shows the composing text on the `Type your own answer...` row instead of in the footer. Thanks to @cmj1203 for the report ([#4400](https://github.com/code-yeongyu/senpi/issues/4400))
