#!/usr/bin/env node

/**
 * Flags every Bun bundle or compile of senpi's release entry graph passes (senpi#6045).
 *
 * linkedom loads `canvas` as an optional peer behind `try { require("canvas") } catch { shim }`, but
 * Bun still resolves canvas's `require("../build/Release/canvas.node")` at build time and fails when the
 * native binding was never built (any lifecycle-disabled install). Keeping canvas external lets linkedom
 * use its JS shim, as the Node bundle (`build-coding-agent-bundle.mjs`) already does. The shell and
 * package.json compile commands cannot import this module; `build-binaries-flags.test.mjs` pins them to it.
 */
export const bunReleaseExternalFlags = Object.freeze(["--external", "canvas"]);
