// Test bootstrap: neutralize the developer's terminal-multiplexer environment
// before any TUI test runs.
//
// TUI multiplexer detection (`isMultiplexerSession` in `src/mux.ts`) reads
// TMUX/TMUX_PANE/STY/ZELLIJ from `process.env` to decide whether to preserve
// pane scrollback, which suppresses the `ESC[3J` scrollback reset on the
// default render path. Tests that assert that default, non-multiplexer path
// would otherwise fail when the suite is run inside tmux/screen/zellij — even
// though CI (which has no multiplexer) passes — because they inherit the
// ambient markers.
//
// Clearing the markers here makes the test baseline deterministic and identical
// to CI regardless of the developer's terminal. Tests that exercise the
// multiplexer render path opt in explicitly via `withEnv({ TMUX: ... })` or an
// injected `muxDetector`, so this scrub never hides multiplexer behavior.
//
// Wired in via `--import ./test/setup-multiplexer-env.mjs` in the package
// `test` script. Node's test runner propagates `--import` to the per-file
// worker processes, so every test file starts from the same non-multiplexer
// baseline. Kept as plain `.mjs` so it loads without the tsx transform and is
// not subject to the src-only build type-check.

for (const key of ["TMUX", "TMUX_PANE", "STY", "ZELLIJ"]) {
	delete process.env[key];
}
