# W1 Native Core Slop Review

Verdict: PASS.

Reviewed paths:

- `crates/senpi-pty/src/session.rs`
- `crates/senpi-pty/src/session_threads.rs`
- `crates/senpi-pty/src/lib.rs`

## Review Categories

| Category | Result | Evidence / rationale |
|---|---|---|
| Overfit behavior | Pass | The split preserves existing PTY lifecycle behavior and does not add branch-specific command names, test-only paths, or environment assumptions. |
| Fake abstraction | Pass | `session_threads.rs` owns only reader and timeout thread helpers extracted from `session.rs`; the abstraction is responsibility-based and has two direct call sites from session startup. |
| Dead or duplicated code | Pass | No removed functionality, no duplicate timeout/read loops, and no unused helper exports beyond `pub(crate)` module boundaries. |
| Hardcoded review bypass | Pass | No SIZE_OK waiver, no allowlist marker, and no hardcoded key/test shortcut added. |
| Unsafe / process safety | Pass | No new `unsafe`; timeout still marks cancellation and sends the configured kill signal through the existing process-group path. |
| Error handling slop | Pass | Existing `PtyError` mapping and benign kill handling remain unchanged; helper extraction does not swallow new errors. |
| Reviewability / file size | Pass | Pure LOC check shows `session.rs` at 243 and `session_threads.rs` at 39, under the 250-line ceiling. |
| Evidence integrity | Pass | Baseline, post-split, prebuild-refresh, and current lifecycle command transcripts are captured under `.omo/evidence/20260706-b1-w1-gate-fix/`; prior lifecycle transcripts are referenced only as continuity evidence. |

## Findings

No blocking native-core slop findings after the gate-fix split.

## Residual Risks

- The refreshed prebuild is host-specific to `darwin-arm64`, matching the required local `check:prebuild` gate. Other platform prebuilds were not rebuilt in this W1 gate fix.
