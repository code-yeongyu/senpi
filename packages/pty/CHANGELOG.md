# Changelog

## [Unreleased]

### Added

- Added `TerminalSession.terminate({ signal, graceMs, forcedGraceMs })`, which signals the session, waits for the exit, escalates to `SIGKILL`, and resolves with the settled exit (or `null` when the process outlives both waits).
- Added `SessionRegistry` options `forcedExitGraceMs` (wait after the escalated `SIGKILL`, default 1s) and `detachedExitGraceMs` (detached-child grace before `SIGKILL`, default 1s).
- Added an opt-in Bun `Bun.spawn` terminal backend for persistent PTY sessions when `SENPI_BUN_TERMINAL` is truthy; the existing native and pipe-fallback paths remain the defaults.

### Fixed

- `TerminalSession.kill()` no longer swallows an escalation: repeating the last delivered signal stays idempotent, but a different signal (notably `SIGKILL` after an ignored `SIGTERM`) now reaches the backend.
- `SessionRegistry.stop()` escalates to `SIGKILL` when a session outlives the stop grace and reports `stopping` only if the process survives that too; `teardown()` escalates a still-live entry before dropping it instead of abandoning the process.
- Detached-child cleanup now SIGKILLs children still alive after the SIGTERM grace, through both the tracked `kill` callback and the process-group/pid path.
