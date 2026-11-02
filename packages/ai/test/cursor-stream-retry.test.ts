import { describe, expect, it } from "vitest";
import {
	CursorRetryableStreamError,
	cursorStreamRetryDelayMs,
	isCursorRetryableStreamError,
	shouldRetryCursorStream,
} from "../src/api/cursor-agent/stream-retry.ts";

describe("cursor stream retry policy", () => {
	it("exponentially backs off and clamps before jitter", () => {
		expect(cursorStreamRetryDelayMs({ attempt: 0, random: () => 0 })).toBe(1000);
		expect(cursorStreamRetryDelayMs({ attempt: 6, random: () => 0 })).toBe(60_000);
		expect(cursorStreamRetryDelayMs({ attempt: 20, random: () => 1 })).toBe(72_000);
	});

	it("keeps jitter within 0-20 percent and allows a fixed test delay", () => {
		expect(cursorStreamRetryDelayMs({ attempt: 2, random: () => 0 })).toBe(4000);
		expect(cursorStreamRetryDelayMs({ attempt: 2, random: () => 1 })).toBe(4800);
		expect(cursorStreamRetryDelayMs({ attempt: 20, fixedDelayMs: 3, random: () => 1 })).toBe(3);
	});

	it("retries only classified pre-turn transport failures within budget", () => {
		const error = new CursorRetryableStreamError("stalled", "stall");
		expect(isCursorRetryableStreamError(error)).toBe(true);
		expect(shouldRetryCursorStream({ error, retries: 0, maxRetries: 1, sawTurnEnded: false, aborted: false })).toBe(
			true,
		);
		expect(shouldRetryCursorStream({ error, retries: 1, maxRetries: 1, sawTurnEnded: false, aborted: false })).toBe(
			false,
		);
		expect(shouldRetryCursorStream({ error, retries: 0, maxRetries: 1, sawTurnEnded: true, aborted: false })).toBe(
			false,
		);
		expect(
			shouldRetryCursorStream({
				error: new Error("grpc"),
				retries: 0,
				maxRetries: 1,
				sawTurnEnded: false,
				aborted: false,
			}),
		).toBe(false);
	});
});
