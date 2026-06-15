# changes.md — webfetch (vendored)

Vendored from [`code-yeongyu/pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) (see `external-versions.json`).

## Senpi adaptations vs upstream

- Imports rewritten by `scripts/vendor-transform.mjs`: `@mariozechner/pi-{ai,tui}` -> `@earendil-works/pi-{ai,tui}`; `@mariozechner/pi-coding-agent` symbols -> `../../types.ts` (and `Theme` -> `modes/interactive/theme/theme.ts`); relative `.js` import suffixes -> `.ts`.
- `webfetch/fetcher.ts`: `buildHeaders` return type `HeadersInit` -> `Record<string, string>` (senpi's root tsconfig has no DOM lib, so the `HeadersInit` global is unavailable; the value is already a plain string record).
- Runtime dep `turndown` (+ `@types/turndown`) added to `package.json`.
- No behavior changes. Registers the `webfetch` tool, gated by `PI_WEBFETCH` (default on).

## Conflict zones

Re-vendoring overwrites these files; this is a MANUAL_PACKAGES entry in `scripts/sync-builtin-extensions.mjs` (metadata only, no auto file-sync). Re-apply the `HeadersInit` patch after re-running the transform, then re-check `npm run check`.
