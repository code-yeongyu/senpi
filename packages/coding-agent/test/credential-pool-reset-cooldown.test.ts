import { describe, expect, test } from "vitest";
import { COOLDOWN_BASE_MS, COOLDOWN_CAP_MS, classifyCredentialFailure } from "../src/core/credential-pool/classify.ts";

// 2026-09-30 12:00 in Asia/Seoul.
const NOW_MS = Date.UTC(2026, 8, 30, 3, 0, 0);
const HOUR_MS = 3_600_000;
const NOW_S = NOW_MS / 1000;

function cooldownOf(error: Error): { cooldownMs: number; retryAfterWasCapped: boolean } {
	const action = classifyCredentialFailure(error, { nowMs: NOW_MS });
	if (action.kind !== "failover" || action.block.reason !== "rate_limit") {
		throw new Error(`expected a rate-limit failover, got ${JSON.stringify(action)}`);
	}
	return { cooldownMs: action.block.cooldownMs, retryAfterWasCapped: action.block.retryAfterWasCapped };
}

function withStatus(message: string, status: number, headers: Record<string, string>): Error {
	return Object.assign(new Error(message), { status, headers });
}

function localWallClockMs(month: number, day: number, hour: number): number {
	return new Date(2026, month, day, hour, 0, 0, 0).getTime();
}

function codexBody(fields: Record<string, unknown>): string {
	return `OpenAI API error (429): ${JSON.stringify({
		error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", ...fields },
	})}`;
}

describe("a usage limit's reset time becomes that account's cooldown (senpi#1768)", () => {
	test.each([
		["reset header", withStatus("The usage limit has been reached", 429, { "retry-after": "3600" }), HOUR_MS],
		["body reset timestamp (Codex resets_at)", new Error(codexBody({ resets_at: NOW_S + 5400 })), 5400_000],
		["body seconds field (reset_after_seconds)", new Error(codexBody({ reset_after_seconds: 7200 })), 2 * HOUR_MS],
		[
			"ChatGPT friendly message",
			new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min."),
			42 * 60_000,
		],
		["relative prose", new Error("You've hit your session limit \u00b7 resets in 3 hours"), 3 * HOUR_MS],
		[
			"Claude clock with zone",
			new Error("You've hit your session limit \u00b7 resets 12am (Asia/Seoul)"),
			12 * HOUR_MS,
		],
		[
			"Claude clock with zone, later today",
			new Error("You've hit your weekly limit \u00b7 resets 5am (Asia/Seoul)"),
			17 * HOUR_MS,
		],
	] as const)("%s", (_label, error, expected) => {
		expect(cooldownOf(error)).toEqual({ cooldownMs: expected, retryAfterWasCapped: false });
	});

	test("a clock time without a zone reads as local time", () => {
		const error = new Error("You've reached your usage limit. Try again at 12:00 AM.");
		const nextLocalMidnight = new Date(NOW_MS);
		nextLocalMidnight.setHours(24, 0, 0, 0);
		expect(cooldownOf(error).cooldownMs).toBe(nextLocalMidnight.getTime() - NOW_MS);
	});

	test("a month-day reset without a zone reads as local time", () => {
		const error = new Error("You've hit your Fable weekly limit \u00b7 resets Oct 2, 9am");
		// Local time differs per host zone, so the 48 h cap may or may not apply.
		const untilReset = localWallClockMs(9, 2, 9) - NOW_MS;
		expect(cooldownOf(error)).toEqual({
			cooldownMs: Math.min(untilReset, COOLDOWN_CAP_MS),
			retryAfterWasCapped: untilReset > COOLDOWN_CAP_MS,
		});
	});

	test("a reset far in the future is capped, and the account still fails over", () => {
		const action = classifyCredentialFailure(new Error(codexBody({ resets_at: NOW_S + 10 * 24 * 3600 })), {
			nowMs: NOW_MS,
		});
		expect(action).toEqual({
			kind: "failover",
			block: { reason: "rate_limit", cooldownMs: COOLDOWN_CAP_MS, retryAfterWasCapped: true },
		});
	});

	test.each([
		["no reset time", new Error("Codex error: The usage limit has been reached")],
		["hour out of range", new Error("You've hit your session limit \u00b7 resets 25pm (Asia/Seoul)")],
		["unknown zone", new Error("You've hit your session limit \u00b7 resets 12am (Mars/Olympus_Mons)")],
		["non-numeric reset field", new Error(codexBody({ resets_at: "soon" }))],
		["past reset timestamp", new Error(codexBody({ resets_at: NOW_S - 3600 }))],
		["past ISO reset", new Error("You've hit your session limit, resets at 2026-09-29T00:00:00Z")],
	] as const)("%s keeps the default cooldown", (_label, error) => {
		expect(cooldownOf(error)).toEqual({ cooldownMs: COOLDOWN_BASE_MS, retryAfterWasCapped: false });
	});

	test("a plain rate limit keeps today's cooldown: its reset header is not read", () => {
		expect(cooldownOf(withStatus("Too Many Requests", 429, { "retry-after": "3600" }))).toEqual({
			cooldownMs: COOLDOWN_BASE_MS,
			retryAfterWasCapped: false,
		});
	});
});
