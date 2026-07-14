# packages/neo/internal/ui

Bubble Tea UI domains for editing, transcript rendering, overlays, commands, extension UI, and shell interaction.

## STRUCTURE

```text
editor/        Multiline editor, width, selection, completion
transcript/    Messages, wrapping, images, streamed output
markdown/      Markdown parsing and styled rendering
overlays/      Modal composition, focus, sizing, stacking
keybindings/   Configurable action mapping
slash/         Slash command parsing and completion
shell/         Interactive shell UI
builtinext/    Builtin extension presentation
extui/         Remote extension UI projection
*/qaharness/   Deterministic real-render drivers
```

## INVARIANTS

- Keep Bubble Tea `Update` paths deterministic and non-blocking; new long-running work should return commands/messages. Treat the existing editor autocomplete goroutine and direct state update as a compatibility exception, not a pattern to extend.
- Keybindings and colors come from registries/themes. Do not hardcode shortcuts or styling in feature code.
- Preserve Unicode cell width, grapheme, wrapping, cursor, selection, and terminal-image behavior across viewport sizes.
- Overlay focus, stacking, cancellation, and resize behavior must remain explicit. Components may not write directly around the renderer.
- Remote extension UI input is untrusted protocol data; validate shapes and keep lifecycle cleanup bounded to the owning request/session.
- Platform and terminal-capability fallbacks must degrade predictably without claiming unsupported visual behavior.

## VISUAL QA

- Use the matching `<area>/qaharness` for behavior and rendering changes.
- Captures are ANSI/HTML/grid triplets under `packages/neo/qa/triplets/`; registered claims live in `packages/neo/qa/visual-claims*.json`.
- Verify manifests with `node packages/neo/qa/xterm-render.mjs verify-manifest <manifest.json>` at representative widths and capability modes.
- Never update snapshots or claims merely to hide a rendering regression; inspect the cell grid and terminal output first.

## VALIDATION

- Run focused Go tests for the changed UI package.
- Run `go build ./...`, `go vet ./...`, and `go test ./...` from `packages/neo` for shared UI contracts.
- User-visible changes require real TUI inspection plus the relevant committed visual evidence.
