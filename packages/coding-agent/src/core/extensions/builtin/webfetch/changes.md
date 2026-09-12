# changes.md — webfetch (vendored)

Vendored from [`code-yeongyu/pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) (see `external-versions.json`).

## Senpi adaptations vs upstream

- Imports rewritten by `scripts/vendor-transform.mjs`: `@mariozechner/pi-{ai,tui}` -> `@earendil-works/pi-{ai,tui}`; `@mariozechner/pi-coding-agent` symbols -> `../../types.ts` (and `Theme` -> `modes/interactive/theme/theme.ts`); relative `.js` import suffixes -> `.ts`.
- `webfetch/fetcher.ts`: `buildHeaders` return type `HeadersInit` -> `Record<string, string>` (senpi's root tsconfig has no DOM lib, so the `HeadersInit` global is unavailable; the value is already a plain string record).
- Runtime deps `@mozilla/readability`, `jsdom`, and `turndown` (+ `@types/jsdom`, `@types/turndown`) added to `package.json`.
- HTML markdown/text responses now pass through Readability before conversion so reader-style article content is returned without nav/header/footer/aside/script page chrome. Registers the `webfetch` tool, gated by `PI_WEBFETCH` (default on).
- Tistory-style article containers are preferred over surrounding blog chrome, noisy related-post/sidebar blocks are stripped from the cloned article, and text conversion uses a DOM pass to preserve readable line breaks.
- Standalone Bun builds rewrite jsdom 29's eager worker lookup to select the compiled worker entry only in standalone executables while retaining jsdom's normal `require.resolve()` behavior under Node, then compile that worker as an explicit entrypoint. Without both steps, the executable captures the CI checkout path and fails during startup on machines where that path does not exist. This must be handled in the host build because an extension cannot change third-party module resolution inside an already-compiled executable.

## 2026-08-23 - Redirect body cleanup supports Bun's bare Undici response

### What changed

- `packages/coding-agent/src/core/extensions/builtin/webfetch/webfetch/fetcher.ts` now feature-detects the response body's optional `dump()` method. It preserves Undici's bounded dump when available, falls back to argument-free `destroy()` when unavailable, and uses the same argument-free fallback when dumping fails.

### Why

- Bun 1.4.0 can expose a bare `undici` redirect response body that supports async iteration and `destroy()` but not Undici's `dump()` convenience method. Calling the missing method produced a `TypeError`, and passing that cleanup error to `destroy(error)` could re-emit it as an uncaught stream error.

### Why an extension could not handle it

- Redirect disposal happens inside the vendored fetcher's private HTTP redirect loop before the registered webfetch extension receives a response, so an extension hook cannot replace or intercept this cleanup.

### Expected merge conflict zones

- LOW in `packages/coding-agent/src/core/extensions/builtin/webfetch/webfetch/fetcher.ts` at the `ResponseBodyStream` contract and `discardBody`; re-vendoring may restore a required `dump()` method and error-bearing `destroy(error)` fallback, so retain the runtime feature detection and argument-free destroy behavior.

## 2026-08-23 - Discard fallback drains and guards stream errors

### What changed

- The no-`dump()` fallback now drains the response body through abort-aware async iteration, bounded by `MAX_RESPONSE_SIZE_BYTES`, before quiet destruction.
- Cleanup attaches an error listener before destruction so a stream error emitted during best-effort discard cannot escape as an unhandled process error.

### Why

- The upstream [`pi-webfetch` PR #7](https://github.com/code-yeongyu/pi-webfetch/pull/7) identified the remaining lifecycle edge: destroying immediately can leave a readable body undrained, and a failing stream can emit an unhandled error while it is being destroyed. This adaptation preserves the bounded `dump()` path while adopting the safer drain-and-guard behavior for Bun-compatible bodies.

### Why an extension could not handle it

- Redirect and oversized-response disposal happen inside the vendored fetcher's private request loop before the registered webfetch tool receives a response, so downstream extension hooks cannot replace this cleanup.

### Expected merge conflict zones

- LOW in `packages/coding-agent/src/core/extensions/builtin/webfetch/webfetch/fetcher.ts` at the import and cleanup call sites, and in the new `response-body.ts` cleanup module.

## 2026-08-20 - HTML converters load on first conversion instead of at CLI startup

### What changed

- New `webfetch/content.lazy.ts` wraps `webfetch/content.ts` behind a single deferred import and exposes the
  same two functions as async, so jsdom, `@mozilla/readability` and turndown load on the first HTML conversion
  instead of at process start.
- `webfetch/tool.ts` imports the converters from that boundary and awaits `htmlToMarkdown` / `htmlToText`. Both
  call sites already sat inside the tool's async `execute`, so the conversion result, output shape and error
  behavior are unchanged.

### Why

- jsdom is the single heaviest package in the CLI's startup import graph, and nothing in it is needed until the
  webfetch tool actually converts an HTML response. Deferring it removes that parse/evaluate cost from every
  run, and costs a conversion nothing beyond the one-time load that run would have paid anyway.

### Why an extension could not handle it

- The import edge originates in this vendored builtin's own tool module, which the core loads during extension
  registration. An extension cannot remove an import edge from a module the core already loads.

### Expected merge conflict zones

- LOW in `webfetch/tool.ts` at the `content` import line and at the two conversion call sites inside `execute`;
  re-vendoring from `code-yeongyu/pi-webfetch` restores the direct import and the non-awaited calls, so this
  boundary must be re-applied together with the `HeadersInit` patch noted below.
- `webfetch/content.ts` itself is untouched, so a re-vendor of that file cannot conflict.

## 2026-08-26 - Port pi-webfetch PR #8 regression coverage

### What changed

- Added the one-redirect end-to-end regression, including final markdown content and the exact visited path sequence.
- Strengthened explicit-article extraction coverage with a module-level Readability parse counter so the test fails if fallback parsing runs.
- Added discard-body coverage for a body already destroyed before cleanup; existing senpi coverage already exercises dump success/failure, no-dump draining, drain errors, aborts, and the response-size bound.

### Why

- The merged upstream PR #8 added redirect and mutation-sensitive explicit-article regressions plus dump feature-detection coverage. Senpi already contains the corresponding cleanup implementation and stronger drain lifecycle coverage, but lacked these specific regression assertions.
- Senpi retains `on?.("error")` rather than upstream's `once("error")`: the vendored response-body contract allows bodies without an error-listener API, and the optional registration guards both Bun-compatible bare bodies and Undici bodies without changing cleanup semantics. No defect was found requiring a semantic change.

### Why an extension could not handle it

- Redirect body disposal occurs inside the vendored fetcher's private request loop, before the webfetch extension receives a response. The explicit article and response-body test coverage targets vendored builtin modules directly.

### Expected merge conflict zones

- LOW in the webfetch suite tests and `changes.md`; production webfetch implementation is unchanged.

## Conflict zones

Re-vendoring overwrites these files; this is a MANUAL_PACKAGES entry in `scripts/sync-builtin-extensions.mjs` (metadata only, no auto file-sync). Re-apply the `HeadersInit` patch and Tistory article/noise selector behavior after re-running the transform, then re-check `npm run check`. A jsdom upgrade can also change the worker lookup patched by `scripts/prepare-bun-compile-assets.mjs`; keep its fixture and the explicit worker entrypoints in `scripts/build-binaries.sh` and `packages/coding-agent/package.json` aligned.
