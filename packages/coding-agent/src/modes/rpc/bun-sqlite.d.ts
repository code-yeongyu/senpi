// The `bun:sqlite` declaration lives exactly once, in
// `packages/session-backends/sqlite-bun/src/bun-sqlite.d.ts`. This file only
// references it: `packages/coding-agent/tsconfig.build.json` includes just
// this package's `src/`, so without this file the `bun:sqlite` import in
// `ownership-safe-lock.ts` and `endpoint-reservation-store.ts` fails the
// build typecheck with TS2307 (senpi#6255). Under the root tsconfig the
// declaration is already in scope through the session-backends include, so
// this reference adds no second declaration.
/// <reference path="../../../../session-backends/sqlite-bun/src/bun-sqlite.d.ts" />
