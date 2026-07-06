# visual-claims.json — schema

The visual-claims manifest is the coverage ledger for every neo TUI visual
claim. It closes the gap where triplet-complete evidence could still omit a
required frame entirely: `verify-manifest` (in `qa/xterm-render.mjs`) FAILS when
any registered claim is missing a frame, missing a triplet leg, or has no
PASSING grid-based assertion. It is consumed by task 20's senpi-qa channel (which
ends by running `verify-manifest`), task 21 (comparison layer), and F1/F3.

## Top level

```jsonc
{
  "description": "...",       // human notes
  "claims": [ Claim, ... ]     // every registered visual claim
}
```

## Claim

```jsonc
{
  "id": "task-2-theme-surfaces-truecolor",  // unique, stable
  "task": 2,                                  // originating todo number
  "title": "human summary",
  "requiredFrames": ["frame-id", ...],       // every id here MUST be provided
  "frames": [ Frame, ... ],                   // the triplet legs per frame
  "assertions": [ Assertion, ... ]            // grid-based; ≥1 must PASS
}
```

A claim PASSES verification only when: every `requiredFrames` id is present in
`frames`; every provided frame's `ans`/`html`/`json` file exists on disk; at
least one assertion produces a PASS; and no assertion targets a frame without a
grid JSON. Paths are resolved relative to the manifest's directory.

## Frame (one triplet, size × state)

```jsonc
{
  "id": "theme-sample-truecolor-120x8",
  "size": "120x8",                 // cols x rows
  "state": "theme-sample-truecolor",
  "ans":  "triplets/....ans",      // (1) raw capture
  "html": "triplets/....html",     // (2) self-contained HTML review page
  "json": "triplets/....json"      // (3) extracted per-cell grid JSON
}
```

## Assertion (runs against the frame's grid JSON)

Assertions are re-executed by `verify-manifest` against the on-disk grid, so the
manifest cannot lie about a passing result. Supported `kind`s (see
`runAssertion` in `xterm-render.mjs`):

- `cell-fg` `{frame,x,y,hex}` — cell fg truecolor hex equals `hex`.
- `cell-bg` `{frame,x,y,hex}` — cell bg truecolor hex equals `hex`.
- `cell-glyph` `{frame,x,y,glyph}` — cell glyph equals `glyph`.
- `glyph-present` `{frame,glyph}` — glyph appears somewhere in the grid.
- `region-fg-subset` `{frame,x0,y0,x1,y1,palette:[hex...]}` — every fg hex in the
  region is a member of `palette` (the "cell colors ⊆ capture palette" check).
- `region-bg-subset` — same, for backgrounds.
- `region-no-truecolor` `{frame,x0,y0,x1,y1}` — no cell in the region carries a
  truecolor fg/bg (the 256-color / NO_COLOR fallback proof).

## Adding claims (later tasks)

Append new `Claim` objects; keep frame ids globally unique. Store triplets under
`qa/triplets/` (committed, deterministic) so `verify-manifest` runs anywhere the
repo is checked out, and mirror them into the task's evidence directory.
