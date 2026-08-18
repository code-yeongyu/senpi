/**
 * Loop-guard thresholds.
 *
 * Evidence base (see changes.md for the full rationale):
 * - gemini-cli LoopDetectionService: sha256(name+args) signatures, cycle periods 1..5,
 *   threshold 5 repetitions — but it HALTS the run. Loop-guard only steers a reminder,
 *   so it can afford to fire earlier.
 * - OpenHands stuck detector: 4+ identical action-observation pairs, 3+ error cycles,
 *   6+ alternating ping-pong cycles — also halting behavior.
 * - Corpus of 400 real senpi sessions: productive same-tool runs (bash/eval/edit/todo)
 *   show mean adjacent-args bigram-Dice ~0.52-0.55 (p90 <= 0.72), while repetitive
 *   classes (read pagination, bash_output/task_output polling) sit at 0.84-0.93.
 *   0.85 cleanly separates distinct work from near-identical repetition.
 */

/** Max tool-call records kept per prompt segment. Covers 6-period cycles at escalated counts. */
export const TRACK_WINDOW = 64;

/** Consecutive byte-identical (tool + canonical args) calls before the firm reminder fires. */
export const IDENTICAL_RUN_THRESHOLD = 3;

/** Admitted identical-loop reminders ignored before the next same call is blocked. */
export const IDENTICAL_BLOCK_NOTICE_THRESHOLD = 2;

/** Loop-guard-owned blocked calls before the active turn is interrupted. */
export const IDENTICAL_HARD_STOP_BLOCK_THRESHOLD = 3;

/** Consecutive same-tool calls with near-identical args before the caution fires. */
export const SIMILAR_RUN_THRESHOLD = 5;

/** Mean adjacent bigram-Dice similarity over canonical args that counts as "near-identical". */
export const SIMILARITY_THRESHOLD = 0.85;

/** Cycle period bounds (period 1 is the identical detector's job). */
export const CYCLE_MIN_PERIOD = 2;
export const CYCLE_MAX_PERIOD = 6;

/** Full cycle repetitions before the pattern notice fires. */
export const CYCLE_REPETITION_THRESHOLD = 3;

/** A pattern that keeps growing re-notifies only when its count reaches this multiple of the last notice. */
export const ESCALATION_FACTOR = 2;
