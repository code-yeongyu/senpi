import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { normalizeAnthropicRetryFailure } from "../src/utils/retry-profile/failure.ts";

const ALLOWED_KEYS = [
	"origin",
	"kind",
	"message",
	"statusCode",
	"providerCodes",
	"finishReason",
	"retryAfterMs",
	"shouldRetry",
] as const;

const SECRET = "sk-ant-TEST-SECRET-DO-NOT-LEAK";

interface ShapedError extends Error {
	status?: number;
	headers?: Headers;
}

/** Attach SDK-shaped status/headers fields to a plain Error, without casts. */
function shapeError(error: Error, fields: { status?: number; headers?: Headers }): ShapedError {
	return Object.assign(error, fields);
}

/** Recursively collect every string reachable from a value, keys included. */
function deepScanStrings(value: unknown, visit: (s: string) => void): void {
	if (typeof value === "string") {
		visit(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) deepScanStrings(item, visit);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			visit(key);
			deepScanStrings(child, visit);
		}
	}
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

describe("normalizeAnthropicRetryFailure", () => {
	it("429 with quota wording -> quota-exhausted, statusCode 429, retryAfterMs from retry-after header", () => {
		const body = {
			type: "error",
			error: {
				type: "error",
				message:
					"exceeded_current_quota_error: You exceeded your current quota, please check your plan and billing details",
			},
		};
		const error = new RateLimitError(429, body, undefined, new Headers({ "retry-after": "2" }), "rate_limit_error");

		const failure = normalizeAnthropicRetryFailure(error);

		expect(failure.kind).toBe("quota-exhausted");
		expect(failure.statusCode).toBe(429);
		expect(failure.retryAfterMs).toBe(2000);
	});

	it("429 with insufficient-balance wording -> quota-exhausted", () => {
		const error = shapeError(new Error("429 This API key has an insufficient balance"), {
			status: 429,
			headers: new Headers(),
		});

		expect(normalizeAnthropicRetryFailure(error).kind).toBe("quota-exhausted");
	});

	it("429 plain rate-limit throttle (no quota wording) -> http-status", () => {
		const body = { type: "error", error: { type: "rate_limit_error", message: "All tokens rate limited" } };
		const error = new RateLimitError(429, body, undefined, new Headers(), "rate_limit_error");

		const failure = normalizeAnthropicRetryFailure(error);

		expect(failure.kind).toBe("http-status");
		expect(failure.statusCode).toBe(429);
	});

	it("numeric status -> http-status", () => {
		const error = new InternalServerError(
			500,
			{ type: "error", error: { type: "api_error", message: "Internal server error" } },
			undefined,
			new Headers(),
			"api_error",
		);

		const failure = normalizeAnthropicRetryFailure(error);

		expect(failure.kind).toBe("http-status");
		expect(failure.statusCode).toBe(500);
	});

	it("x-should-retry header -> boolean shouldRetry", () => {
		const retryable = shapeError(new Error("503 overloaded"), {
			status: 503,
			headers: new Headers({ "x-should-retry": "true" }),
		});
		const terminal = shapeError(new Error("400 invalid"), {
			status: 400,
			headers: new Headers({ "x-should-retry": "false" }),
		});

		expect(normalizeAnthropicRetryFailure(retryable).shouldRetry).toBe(true);
		expect(normalizeAnthropicRetryFailure(terminal).shouldRetry).toBe(false);
	});

	it("SSE plain Error with JSON body -> provider, providerCodes, statusCode undefined", () => {
		const error = new Error(
			'{"type":"error","error":{"type":"overloaded_error","code":"custom_code","message":"Overloaded"}}',
		);

		const failure = normalizeAnthropicRetryFailure(error);

		expect(failure.kind).toBe("provider");
		expect(failure.statusCode).toBeUndefined();
		expect(failure.providerCodes).toEqual(["overloaded_error", "custom_code"]);
		expect("statusCode" in failure).toBe(false);
	});

	it("SSE plain Error with appended retry-after-ms marker -> provider, marker recovered as number", () => {
		const error = new Error(
			'{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited","retryDelay":"45s"}} (retry-after-ms: 45000)',
		);

		const failure = normalizeAnthropicRetryFailure(error);

		expect(failure.kind).toBe("provider");
		expect(failure.retryAfterMs).toBe(45000);
	});

	it("APIConnectionError-shaped -> connection", () => {
		const failure = normalizeAnthropicRetryFailure(new APIConnectionError({}));

		expect(failure.kind).toBe("connection");
		expect(failure.statusCode).toBeUndefined();
	});

	it("APIConnectionTimeoutError-shaped -> timeout (beats connection)", () => {
		expect(normalizeAnthropicRetryFailure(new APIConnectionTimeoutError()).kind).toBe("timeout");
	});

	it("AbortError -> abort", () => {
		expect(normalizeAnthropicRetryFailure(abortError()).kind).toBe("abort");
	});

	it("narrow image-format rejection -> image-format", () => {
		expect(normalizeAnthropicRetryFailure(new Error("Unsupported image format: image/bmp")).kind).toBe(
			"image-format",
		);
	});

	it("unrecognized plain error -> unknown", () => {
		const failure = normalizeAnthropicRetryFailure(new Error("something completely different"));

		expect(failure.kind).toBe("unknown");
		expect(failure.origin).toBe("anthropic-messages");
	});

	it("message truncated to 500 chars", () => {
		const failure = normalizeAnthropicRetryFailure(new Error("x".repeat(600)));

		expect(failure.message).toHaveLength(500);
	});

	it("SECURITY: authorization header and raw body never leak into the normalized fact", () => {
		const error = shapeError(new Error("429 All tokens rate limited"), {
			status: 429,
			headers: new Headers({
				authorization: `Bearer ${SECRET}`,
				"x-api-key": SECRET,
				"retry-after-ms": "750",
			}),
		});
		const context = {
			bodyText: `{"error":{"type":"rate_limit_error","message":"throttled for ${SECRET}"}}`,
		};

		const failure = normalizeAnthropicRetryFailure(error, context);

		// Whitelist: only the eight declared keys may exist, with values safe to log.
		for (const key of Object.keys(failure)) expect(ALLOWED_KEYS).toContain(key);
		const strings: string[] = [];
		deepScanStrings(failure, (s) => strings.push(s));
		expect(strings.some((s) => s.toLowerCase().includes("authorization"))).toBe(false);
		expect(JSON.stringify(failure).includes(SECRET)).toBe(false);
		expect(failure.retryAfterMs).toBe(750);
		expect(failure.kind).toBe("http-status");
	});
});
