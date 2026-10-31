// EQ.tui capture: the only TUI-specific normalization is §6.2's "durations are dropped". These pin that it drops every
// duration form the TUI renders and masks nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dropRenderedDurations, ELAPSED_ROW_STYLES, tuiObservation } from "./equivalence-tui-capture.mjs";

test("every rendered duration form becomes <duration>", () => {
	for (const [line, expected] of [
		[" Cache hit 0.0%, 0.0s", " Cache hit 0.0%, <duration>"],
		[" Cache hit 0.0%, 12.3s", " Cache hit 0.0%, <duration>"],
		["── • Running eq_read (1s • esc to interrupt) ──", "── • Running eq_read (<duration> • esc to interrupt) ──"],
		[
			" Running PreToolUse hook: matching project rules (2m 00s)",
			" Running PreToolUse hook: matching project rules (<duration>)",
		],
		[" took (1h 02m 03s)", " took (<duration>)"],
		[" flushed in 250ms", " flushed in <duration>"],
	]) {
		assert.equal(dropRenderedDurations(line), expected);
	}
});

test("nothing that is not a duration is masked", () => {
	for (const line of [
		"~/work • QA session • 2/128K (0.0%) (auto)                                                mock-model",
		" senpi v2026.10.27-2",
		' eq_write path="out/client.txt" text="call_by_client\\n" barrier="open-call_by_client"',
		" E01-DONE",
		" compacted from 2 tokens (ctrl+o to expand)",
		" s3 bucket, 10s3, 4x, 3 cores, 12%",
		"   - out/other.txt",
	]) {
		assert.equal(dropRenderedDurations(line), line);
	}
});

test("only a live elapsed-time row loses its style runs; every other row keeps them", () => {
	const lines = [
		" Running PreToolUse hook: matching project rules (2s)",
		"── • Working (12s • esc to interrupt) ──",
		" Cache hit 0.0%, 0.0s",
		' eq_read path="a.txt" (read-a)',
		"~/work • QA session • 2/128K (0.0%) (auto)",
	];
	const styles = lines.map((_, row) => [`0-9 0/-1 0/-1 01000${row}`]);
	const { tui } = tuiObservation({ tuiCheckpoints: [{ label: "final", lines, styles }] }, (value) => value);
	assert.deepEqual(tui[0].lines[0], " Running PreToolUse hook: matching project rules (<duration>)");
	assert.deepEqual(tui[0].styles, [ELAPSED_ROW_STYLES, ELAPSED_ROW_STYLES, styles[2], styles[3], styles[4]]);
});
