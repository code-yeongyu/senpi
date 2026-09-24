# changes.md — nested-agents-md (vendored)

Vendored from [`code-yeongyu/pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) (see `external-versions.json`).

## Senpi adaptations vs upstream

- Imports rewritten by `scripts/vendor-transform.mjs`: `@earendil-works/pi-coding-agent` symbols -> `../../types.ts`; relative `.js` import suffixes -> `.ts`. (This package already used `@earendil-works/pi-*` upstream, so only the coding-agent symbols and suffixes moved.)
- `core/errors.ts`: `InjectionFileReadError` constructor parameter property (`public readonly path`) -> explicit field + constructor assignment (senpi's root tsconfig is `erasableSyntaxOnly`; parameter properties are disallowed).
- No behavior changes. Registers the `/nested-agents` command and injects nearby `AGENTS.md` on nested reads.

## Conflict zones

Re-vendoring overwrites these files; this is a MANUAL_PACKAGES entry in `scripts/sync-builtin-extensions.mjs` (metadata only, no auto file-sync). Re-apply the parameter-property patch after re-running the transform, then re-check `npm run check`.

## 2026-09-23 — Address nested directory instructions only to the model

### What changed

- `packages/coding-agent/src/core/extensions/builtin/nested-agents-md/index.ts`: mark the existing appended Directory Context text part with `audience: "model"`. Its exact text, the original body part, status/widget updates, and cache behavior are unchanged.

### Why

This separate producer injected the same AGENTS.md body without audience metadata, leaving it visible even when the rules extension's own part was model-only.

### Why an extension could not handle it

This built-in extension owns the appended block. It must declare its audience at the source so downstream renderers do not parse or strip instruction text.

### Expected merge conflict zones

The `textBlock` literal in the tool-result handler and future vendoring of this package. Rule-activation attribution and display-only plumbing are unchanged.
