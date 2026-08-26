import { describe, expect, it } from "vitest";

import {
	type CompactionLoggerEvent,
	createCompactionLogger,
} from "../../src/core/extensions/builtin/compaction/log.ts";
import { createTempAgentDir } from "../support/temp-agent-dir.ts";

const LOG_DIR = createTempAgentDir("senpi-compaction-decision-log-");

const EVENTS = [
	"speculative_started",
	"speculative_applied",
	"speculative_stale",
	"speculative_invalidated",
	"warm_consumed",
	"blocking_started",
	"core_route_generated",
	"skip_cap",
	"skip_breaker",
	"threshold_trigger",
	"hard_limit_trigger",
	"emergency_prune",
	"ineffective_counted",
	"summary_failed",
] as const satisfies readonly CompactionLoggerEvent[];

describe("compaction decision log", () => {
	it("Given the event union When counting Then the test cases match exactly", () => {
		expect(EVENTS).toHaveLength(14);
	});

	it.each([
		[
			"speculative_started",
			{ origin: "speculative", generation: 7, requestId: "req-1", reason: "threshold", contextWindow: 4096 },
		],
		[
			"speculative_applied",
			{ origin: "speculative", generation: 7, requestId: "req-2", savedTokens: 1200, savingsRatio: 0.25 },
		],
		["speculative_stale", { origin: "speculative", generation: 7, requestId: "req-3", reason: "stale" }],
		[
			"speculative_invalidated",
			{ origin: "speculative", generation: 7, requestId: "req-4", reason: "newer-generation" },
		],
		["warm_consumed", { origin: "speculative", generation: 7, requestId: "req-5", route: "speculative", count: 1 }],
		[
			"blocking_started",
			{ origin: "blocking", generation: 8, requestId: "req-6", reason: "hard-limit", contextWindow: 8192 },
		],
		["core_route_generated", { origin: "core-route", requestId: "req-7", route: "core-route", generation: 9 }],
		["skip_cap", { origin: "speculative", requestId: "req-8", count: 2, threshold: 3 }],
		["skip_breaker", { origin: "blocking", requestId: "req-9", remainingSec: 12, count: 4 }],
		[
			"threshold_trigger",
			{ origin: "speculative", requestId: "req-10", threshold: 0.9, tokens: 9000, contextWindow: 10000 },
		],
		[
			"hard_limit_trigger",
			{ origin: "blocking", requestId: "req-11", threshold: 0.95, tokens: 9500, contextWindow: 10000 },
		],
		[
			"emergency_prune",
			{ origin: "blocking", requestId: "req-12", route: "emergency", tokensBefore: 12000, tokens: 9000 },
		],
		[
			"ineffective_counted",
			{ origin: "speculative", requestId: "req-13", savedTokens: 500, savingsRatio: 0.05, count: 1 },
		],
		["summary_failed", { origin: "speculative", requestId: "req-14", reason: "transient", durationMs: 77 }],
	] as const)("Given %s When logging Then it emits allowlisted fields only", (event, data) => {
		const sink: string[] = [];
		const logger = createCompactionLogger(LOG_DIR, {
			sink: (line) => sink.push(line),
			mirrorToStderr: false,
		});

		logger.debug(event, data as Record<string, unknown>);

		expect(sink).toHaveLength(1);
		const entry = JSON.parse(sink[0] as string) as Record<string, unknown>;
		expect(entry).toMatchObject({ event, level: "debug", ...data });
		expect(Object.keys(entry).sort()).toEqual(
			[
				"contextWindow",
				"count",
				"event",
				"generation",
				"level",
				"origin",
				"reason",
				"requestId",
				"route",
				"savedTokens",
				"savingsRatio",
				"threshold",
				typeof entry.remainingSec === "number" ? "remainingSec" : "remainingSec",
				"tokens",
				"tokensBefore",
				"ts",
				"variant",
				"durationMs",
			]
				.filter((key) => key in entry)
				.sort(),
		);
		for (const key of ["message", "summary", "prompt", "customInstructions"] as const) {
			expect(entry).not.toHaveProperty(key);
		}
	});

	it("Given injected sink When logging Then it preserves the allowlisted payload", () => {
		const sink: string[] = [];
		const logger = createCompactionLogger(LOG_DIR, {
			sink: (line) => sink.push(line),
			mirrorToStderr: false,
		});

		logger.debug("threshold_trigger", { origin: "speculative", tokens: 11, threshold: 0.5, reason: "threshold" });

		expect(JSON.parse(sink[0] as string)).toMatchObject({
			event: "threshold_trigger",
			level: "debug",
			origin: "speculative",
			tokens: 11,
			threshold: 0.5,
			reason: "threshold",
		});
	});
});
