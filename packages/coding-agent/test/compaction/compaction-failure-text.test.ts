import { shouldRetryOverflowWithoutCompact } from "@earendil-works/pi-ai/utils/overflow";
import { describe, expect, it } from "vitest";
import {
	type CompactionFailureKind,
	type CompactionFailureStep,
	compactionFailureStep,
	formatCompactionFailure,
} from "../../src/core/compaction-failure-text.ts";

// senpi#4329: compaction_end failures carry a cause class and one step, and keep the
// raw cause and the leads that existing consumers read.
const LEADS: ReadonlyArray<readonly [CompactionFailureKind, string]> = [
	["compaction", "Compaction failed: "],
	["auto-compaction", "Auto-compaction failed: "],
	["overflow-recovery", "Context overflow recovery failed: "],
];

describe("formatCompactionFailure", () => {
	it.each(LEADS)("keeps the %s lead and the raw cause, adding a step before it", (kind, lead) => {
		for (const cause of [
			"Connection error.",
			"summary generator blew up",
			"Nothing to compact (session too small)",
		]) {
			const text = formatCompactionFailure(kind, cause);
			expect(text.startsWith(lead)).toBe(true);
			expect(text.endsWith(cause)).toBe(true);
			expect(text).not.toBe(`${lead}${cause}`);
		}
	});

	it("strips the internal replay marker from the cause", () => {
		const text = formatCompactionFailure("compaction", "senpi:no-turn-retry:Connection error.");
		expect(text).not.toContain("senpi:no-turn-retry:");
		expect(text.endsWith("Connection error.")).toBe(true);
	});

	it("keeps the overflow retry signal of a nothing-to-compact cause", () => {
		const text = formatCompactionFailure("overflow-recovery", "Nothing to compact (session too small)");
		expect(shouldRetryOverflowWithoutCompact(false, text)).toBe(true);
	});

	it("routes an account usage limit to its configuration step", () => {
		const text = formatCompactionFailure(
			"compaction",
			'429 {"error":{"message":"You have hit your session limit"}}',
			{
				model: "faux/faux-1",
			},
		);
		expect(text).toContain("retry.fallbackChains");
	});

	it.each<readonly [CompactionFailureKind, string, CompactionFailureStep]>([
		["overflow-recovery", "Connection error.", "resend"],
		["overflow-recovery", "fetch failed", "resend"],
		["overflow-recovery", "503 Service Unavailable", "resend"],
		["overflow-recovery", "socket hang up", "resend"],
		["overflow-recovery", "summary generator blew up", "larger-context"],
		["overflow-recovery", "Nothing to compact (session too small)", "larger-context"],
		["compaction", "Connection error.", "compact-again"],
		["compaction", "Nothing to compact (session too small)", "nothing-to-compact"],
		["auto-compaction", "Already compacted", "nothing-to-compact"],
		["compaction", "WebSocket closed 1006 Connection ended", "provider"],
		["compaction", "Compaction rejected: absolute compaction cap reached for this session.", "self-explained"],
	])("%s with cause %j names the %s step", (kind, cause, step) => {
		expect(compactionFailureStep(kind, cause)).toBe(step);
	});

	it("names no TUI-only command in any step", () => {
		for (const [kind] of LEADS) {
			for (const cause of [
				"Connection error.",
				"summary generator blew up",
				"Nothing to compact (session too small)",
			]) {
				expect(formatCompactionFailure(kind, cause)).not.toMatch(/(?:^|[\s(])\/[a-z][\w-]*/);
			}
		}
	});

	it.each(LEADS)("leaves %s rejections that already name their step unchanged", (kind, lead) => {
		const rejection = "Compaction rejected: absolute compaction cap reached for this session.";
		expect(formatCompactionFailure(kind, rejection)).toBe(`${lead}${rejection}`);
	});
});
