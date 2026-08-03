import { describe, expect, it } from "vitest";
import { appendRetryAfterMsMarker, extract429RetryAfterMs, parseRetryAfterMsMarker } from "../src/utils/retry-hint.ts";

/* ---------- helpers ---------- */

function headers(obj: Record<string, string>): Headers {
	return new Headers(obj);
}

const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic tests

/* ---------- 1. Eligibility gate ---------- */

describe("eligibility gate", () => {
	it("429 status with generic body + retry-after header -> hint from header", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after": "1258" }), bodyText: '{"error":"rate limited"}' },
			NOW,
		);
		expect(result).toBe(1_258_000);
	});

	it("body rate_limit_error type on 200 SSE -> eligible, but no hint -> undefined", () => {
		const result = extract429RetryAfterMs(
			{
				status: 200,
				headers: new Headers(),
				bodyText: '{"error":{"type":"rate_limit_error","message":"All tokens rate limited"}}',
			},
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("500 with 'try again in 20 seconds' prose -> NOT eligible -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 500, headers: new Headers(), bodyText: "try again in 20 seconds" },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("503 + prose -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 503, headers: new Headers(), bodyText: "try again in 30 seconds" },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("429 status with no hint anywhere -> undefined", () => {
		const result = extract429RetryAfterMs({ status: 429, headers: new Headers(), bodyText: "rate limited" }, NOW);
		expect(result).toBeUndefined();
	});

	it("200 with rate_limit_exceeded type code -> eligible, no hint -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 200, headers: new Headers(), bodyText: '{"error":{"type":"rate_limit_exceeded"}}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("200 with resource_exhausted type -> eligible, no hint -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 200, headers: new Headers(), bodyText: '{"error":{"type":"resource_exhausted"}}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("200 with too_many_requests code string -> eligible, no hint -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 200, headers: new Headers(), bodyText: '{"error":{"code":"too_many_requests"}}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("200 with numeric code 429 -> eligible, no hint -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 200, headers: new Headers(), bodyText: '{"error":{"code":429}}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("200 with standalone text marker 'rate limit exceeded' -> eligible, no hint -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 200, headers: new Headers(), bodyText: "rate limit exceeded" },
			NOW,
		);
		expect(result).toBeUndefined();
	});
});

/* ---------- 2. retry-after-ms header (highest precedence) ---------- */

describe("retry-after-ms header", () => {
	it("strict integer", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after-ms": "5000" }), bodyText: "" },
			NOW,
		);
		expect(result).toBe(5000);
	});

	it("strict decimal ceil", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after-ms": "2.3" }), bodyText: "" },
			NOW,
		);
		expect(result).toBe(3);
	});

	it("malformed 'later' falls through to retry-after: 12 -> 12000", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after-ms": "later", "retry-after": "12" }), bodyText: "" },
			NOW,
		);
		expect(result).toBe(12_000);
	});

	it("'12junk' is malformed (strict full-string) -> falls through", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after-ms": "12junk", "retry-after": "5" }), bodyText: "" },
			NOW,
		);
		expect(result).toBe(5_000);
	});

	it("explicit zero beats lower-precedence positive prose 30s", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after-ms": "0" }), bodyText: "try again in 30 seconds" },
			NOW,
		);
		expect(result).toBe(0);
	});
});

/* ---------- 3. retry-after header (delta-seconds or HTTP-date) ---------- */

describe("retry-after header", () => {
	it("integer delta-seconds", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after": "1258" }), bodyText: "generic" },
			NOW,
		);
		expect(result).toBe(1_258_000);
	});

	it("explicit zero beats prose 30s", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after": "0" }), bodyText: "try again in 30 seconds" },
			NOW,
		);
		expect(result).toBe(0);
	});

	it("0.5 is malformed (strict integer) -> falls through", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after": "0.5" }), bodyText: "" },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("HTTP-date with skewed local clock using Date header", () => {
		// Server says Date is 2023-11-14T22:13:20.000Z (epoch 1700000000000)
		// Retry-After is 60s after that -> 1700000060000
		// nowMs is deliberately skewed (1 hour ahead)
		const skewedNow = NOW + 3_600_000;
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({
					date: "Tue, 14 Nov 2023 22:13:20 GMT",
					"retry-after": "Tue, 14 Nov 2023 22:14:20 GMT",
				}),
				bodyText: "",
			},
			skewedNow,
		);
		expect(result).toBe(60_000);
	});

	it("HTTP-date without Date header uses nowMs, clamps past to 0", () => {
		// Date is in the past relative to nowMs
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({ "retry-after": "Tue, 14 Nov 2023 22:00:00 GMT" }),
				bodyText: "",
			},
			NOW, // 1700000000000 = 22:13:20 UTC, after 22:00:00
		);
		expect(result).toBe(0);
	});

	it("HTTP-date IMF-fixdate format", () => {
		// Use Date header so result is deterministic
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({
					date: "Tue, 14 Nov 2023 22:13:20 GMT",
					"retry-after": "Tue, 14 Nov 2023 22:14:30 GMT",
				}),
				bodyText: "",
			},
			NOW,
		);
		expect(result).toBe(70_000);
	});

	it("malformed retry-after 'abc' falls through to x-ratelimit-reset", () => {
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({ "retry-after": "abc", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 10) }),
				bodyText: "",
			},
			NOW,
		);
		expect(result).toBe(10_000);
	});
});

/* ---------- 4. x-ratelimit-reset* headers (epoch seconds, max-wins) ---------- */

describe("x-ratelimit-reset headers", () => {
	it("reset-requests +5s and reset-tokens +60s -> 60_000 (max wins)", () => {
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({
					"x-ratelimit-reset-requests": String(Math.floor(NOW / 1000) + 5),
					"x-ratelimit-reset-tokens": String(Math.floor(NOW / 1000) + 60),
				}),
				bodyText: "",
			},
			NOW,
		);
		expect(result).toBe(60_000);
	});

	it("x-ratelimit-reset (bare) epoch seconds", () => {
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({ "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 30) }),
				bodyText: "",
			},
			NOW,
		);
		expect(result).toBe(30_000);
	});

	it("past epoch clamps to 0", () => {
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({ "x-ratelimit-reset": String(Math.floor(NOW / 1000) - 100) }),
				bodyText: "",
			},
			NOW,
		);
		expect(result).toBe(0);
	});

	it("malformed epoch 'soon' falls through", () => {
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({
					"x-ratelimit-reset": "soon",
					"x-ratelimit-reset-tokens": String(Math.floor(NOW / 1000) + 5),
				}),
				bodyText: "",
			},
			NOW,
		);
		expect(result).toBe(5_000);
	});
});

/* ---------- 5. JSON retryDelay strings (recursive, max-wins, numeric rejected) ---------- */

describe("JSON retryDelay", () => {
	it('{"retryDelay":"0.25s"} -> 250', () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"retryDelay":"0.25s"}' },
			NOW,
		);
		expect(result).toBe(250);
	});

	it('{"retryDelay":"45s"} -> 45000', () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"retryDelay":"45s"}' },
			NOW,
		);
		expect(result).toBe(45_000);
	});

	it('{"retryDelay":"2m"} -> 120000', () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"retryDelay":"2m"}' },
			NOW,
		);
		expect(result).toBe(120_000);
	});

	it('{"retryDelay":"500ms"} -> 500', () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"retryDelay":"500ms"}' },
			NOW,
		);
		expect(result).toBe(500);
	});

	it('{"retryDelay":500} numeric -> rejected, falls through', () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"retryDelay":500}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it('{"retryDelay":"soon"} no unit match -> rejected', () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"retryDelay":"soon"}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("nested JSON max-wins: {outer:{retryDelay:5s}, inner:{retryDelay:60s}}", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"a":{"retryDelay":"5s"},"b":{"retryDelay":"60s"}}' },
			NOW,
		);
		expect(result).toBe(60_000);
	});

	it("retryDelay in array elements", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '[{"retryDelay":"3s"},{"retryDelay":"10s"}]' },
			NOW,
		);
		expect(result).toBe(10_000);
	});

	it("SSE data: payload with retryDelay 45s -> 45000", () => {
		const result = extract429RetryAfterMs(
			{ status: 200, headers: new Headers(), bodyText: 'data: {"retryDelay":"45s"}\n\n' },
			NOW,
		);
		expect(result).toBe(45_000);
	});

	it("SSE data: payload with rate_limit_error body and retryDelay", () => {
		const result = extract429RetryAfterMs(
			{
				status: 200,
				headers: new Headers(),
				bodyText: 'data: {"error":{"type":"rate_limit_error"},"retryDelay":"45s"}\n\n',
			},
			NOW,
		);
		expect(result).toBe(45_000);
	});
});

/* ---------- 6. Body prose patterns ---------- */

describe("body prose", () => {
	it("ms-marker: 'retry-after-ms: 5000'", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "error: retry-after-ms: 5000" },
			NOW,
		);
		expect(result).toBe(5000);
	});

	it("seconds-marker: 'retry-after: 30'", () => {
		const result = extract429RetryAfterMs({ status: 429, headers: new Headers(), bodyText: "retry-after: 30" }, NOW);
		expect(result).toBe(30_000);
	});

	it("relative prose: 'try again in 20 seconds'", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "try again in 20 seconds" },
			NOW,
		);
		expect(result).toBe(20_000);
	});

	it("relative prose: 'retry in 5 seconds'", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "retry in 5 seconds" },
			NOW,
		);
		expect(result).toBe(5_000);
	});

	it("relative prose: 'wait after 10 seconds'", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "wait after 10 seconds" },
			NOW,
		);
		expect(result).toBe(10_000);
	});

	it("relative prose with minutes: 'try again in 3 minutes'", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "try again in 3 minutes" },
			NOW,
		);
		expect(result).toBe(180_000);
	});

	it("relative prose with ms: 'try again in 500 ms'", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "try again in 500 ms" },
			NOW,
		);
		expect(result).toBe(500);
	});

	it("resets at <ISO8601-with-tz>", () => {
		// 2023-11-14T22:14:20Z = 1700000060000, which is 60s after NOW
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "rate limit resets at 2023-11-14T22:14:20Z" },
			NOW,
		);
		expect(result).toBe(60_000);
	});

	it("resets at <ISO8601-with-tz> past -> 0", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "rate limit resets at 2023-11-14T22:00:00Z" },
			NOW,
		);
		expect(result).toBe(0);
	});

	it("ms-marker beats seconds-marker (precedence)", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: "retry-after: 30 retry-after-ms: 5000" },
			NOW,
		);
		expect(result).toBe(5000);
	});
});

/* ---------- 7. Precedence: explicit zero beats lower-precedence positive ---------- */

describe("explicit zero precedence", () => {
	it("retry-after: 0 + prose 30s -> 0", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after": "0" }), bodyText: "try again in 30 seconds" },
			NOW,
		);
		expect(result).toBe(0);
	});

	it("retry-after-ms: 0 + retry-after: 60 -> 0 (higher precedence wins with zero)", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: headers({ "retry-after-ms": "0", "retry-after": "60" }), bodyText: "" },
			NOW,
		);
		expect(result).toBe(0);
	});

	it("x-ratelimit-reset epoch now + retryDelay 5s -> 0 (epoch now = 0 delta, beats retryDelay)", () => {
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: headers({ "x-ratelimit-reset": String(Math.floor(NOW / 1000)) }),
				bodyText: '{"retryDelay":"5s"}',
			},
			NOW,
		);
		expect(result).toBe(0);
	});
});

/* ---------- 8. Malformed / adversarial inputs ---------- */

describe("malformed and adversarial inputs", () => {
	it("garbage body text -> undefined", () => {
		const result = extract429RetryAfterMs({ status: 429, headers: new Headers(), bodyText: "asdfghjkl" }, NOW);
		expect(result).toBeUndefined();
	});

	it("empty body -> undefined", () => {
		const result = extract429RetryAfterMs({ status: 429, headers: new Headers(), bodyText: "" }, NOW);
		expect(result).toBeUndefined();
	});

	it("garbage JSON object -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"foo":"bar","baz":[1,2,3]}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("bodyText with retryDelay in a string value (not key) -> undefined", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"message":"retryDelay is unknown"}' },
			NOW,
		);
		expect(result).toBeUndefined();
	});

	it("deeply nested retryDelay max-wins", () => {
		const result = extract429RetryAfterMs(
			{
				status: 429,
				headers: new Headers(),
				bodyText: '{"a":{"b":{"c":{"retryDelay":"1s"}},"d":{"retryDelay":"100s"}}}',
			},
			NOW,
		);
		expect(result).toBe(100_000);
	});

	it("retryDelay with both s and ms: 45s and 500ms -> max 45000", () => {
		const result = extract429RetryAfterMs(
			{ status: 429, headers: new Headers(), bodyText: '{"a":{"retryDelay":"45s"},"b":{"retryDelay":"500ms"}}' },
			NOW,
		);
		expect(result).toBe(45_000);
	});

	it("nowMs default (no parameter) returns a number when hint exists", () => {
		const result = extract429RetryAfterMs({ status: 429, headers: headers({ "retry-after": "5" }), bodyText: "" });
		expect(result).toBe(5_000);
	});
});

/* ---------- 9. Marker helpers ---------- */

describe("appendRetryAfterMsMarker", () => {
	it("appends marker to message", () => {
		expect(appendRetryAfterMsMarker("rate limited", 1258000)).toBe("rate limited (retry-after-ms: 1258000)");
	});

	it("appends marker with zero", () => {
		expect(appendRetryAfterMsMarker("rate limited", 0)).toBe("rate limited (retry-after-ms: 0)");
	});
});

describe("parseRetryAfterMsMarker", () => {
	it("parses marker from message", () => {
		expect(parseRetryAfterMsMarker("rate limited (retry-after-ms: 1258000)")).toBe(1_258_000);
	});

	it("parses zero marker", () => {
		expect(parseRetryAfterMsMarker("rate limited (retry-after-ms: 0)")).toBe(0);
	});

	it("returns undefined when no marker", () => {
		expect(parseRetryAfterMsMarker("rate limited")).toBeUndefined();
	});

	it("round-trip: append then parse", () => {
		const msg = appendRetryAfterMsMarker("some error", 45000);
		expect(parseRetryAfterMsMarker(msg)).toBe(45_000);
	});
});
