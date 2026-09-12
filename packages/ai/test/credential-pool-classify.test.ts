import { describe, expect, test } from "vitest";
import { classifyPoolFailure } from "../src/auth/pool/classify.ts";

describe("credential pool failure classification", () => {
	test.each([
		[{ status: 429, message: "Too Many Requests" }, "rotate", "rate_limit"],
		[new Error("rate limit exceeded, retry-after: 12"), "rotate", "rate_limit"],
		[new Error("RESOURCE_EXHAUSTED: quota exceeded"), "rotate", "rate_limit"],
		[{ status: 529, message: "overloaded" }, "rotate", "rate_limit"],
		[new Error("Anthropic API error: overloaded_error"), "rotate", "rate_limit"],
		[{ status: 401, message: "Unauthorized" }, "rotate", "auth_error"],
		[{ status: 403, message: "Forbidden" }, "rotate", "auth_error"],
		[new Error("invalid api key provided"), "rotate", "auth_error"],
		[new Error("OAuth token expired or revoked"), "rotate", "auth_error"],
	] as const)("%o classifies as %s/%s", (error, action, blockReason) => {
		const classification = classifyPoolFailure(error);
		expect(classification.action).toBe(action);
		expect(classification.blockReason).toBe(blockReason);
	});

	test.each([
		[{ status: 500, message: "Internal Server Error" }],
		[{ status: 503, message: "Service Unavailable" }],
		[new Error("fetch failed: ECONNRESET")],
		[new Error("socket hang up")],
	] as const)("%o classifies as retry with no block reason", (error) => {
		const classification = classifyPoolFailure(error);
		expect(classification.action).toBe("retry");
		expect(classification.blockReason).toBeUndefined();
	});

	test("unknown failures default-deny to fail", () => {
		const classification = classifyPoolFailure(new Error("model produced invalid tool arguments"));
		expect(classification.action).toBe("fail");
		expect(classification.blockReason).toBeUndefined();
	});

	test("retry-after hints surface in milliseconds", () => {
		expect(classifyPoolFailure({ status: 429, message: "slow down", retryAfterMs: 2_500 }).retryAfterMs).toBe(2_500);
		expect(classifyPoolFailure(new Error("429 rate limited, retry-after: 3")).retryAfterMs).toBe(3_000);
		expect(classifyPoolFailure(new Error("429 rate limited, retry-after-ms: 450")).retryAfterMs).toBe(450);
	});

	test("nested provider error shapes are inspected", () => {
		const classification = classifyPoolFailure({ error: { status: 429, message: "rate limited" } });
		expect(classification.action).toBe("rotate");
		expect(classification.blockReason).toBe("rate_limit");
	});
});
