<!-- changes-log: packages/tui/src/changes.md -->
## 2026-11-02 - A Kitty image appended below a full viewport no longer clears the screen and scrollback (senpi#4583)

### What changed

- `packages/tui/src/tui.ts`: the differential render path no longer falls back to `fullRender(true, clearScrollback)` when a Kitty image's reserved rows reach past the viewport bottom. Reserving those rows writes newlines that scroll the terminal exactly as appended text does, and the relative cursor-up back to the image's first row still lands on it after the scroll, so the image is placed in place. The full-redraw fallback remains for an image that starts above the viewport or is taller than the viewport.

### Why

- An append-only update that added an inline image right below an already-full viewport took the fallback every time, because the image's first row sits at the viewport height. That sent `CSI 2 J`, `CSI 3 J` and replayed the whole transcript, erasing native scrollback outside multiplexers and costing a full-transcript write on image-heavy sessions; the reporter linked it to visible blank frames (senpi#4583, reported by copycatcode).

### Why an extension could not handle it

- The renderer's differential path and its fallback decisions are internal to `TuiBase.doRender()`; components only return lines.

### Expected merge conflict zones

- LOW: the Kitty image reservation branch inside the differential render loop of `doRender()` in `tui.ts`.

<!-- changes-log: packages/tui/CHANGELOG.md -->
### Fixed
- Appending an inline Kitty image below a full terminal screen no longer clears the screen and scrollback and replays the whole transcript; the image scrolls into place like appended text. Thanks to @copycatcode for the report ([#4583](https://github.com/code-yeongyu/senpi/issues/4583))
