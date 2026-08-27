import { describe, expect, test } from "vitest";
import {
	COOLDOWN_BASE_MS,
	COOLDOWN_CAP_MS,
	classifyCredentialFailure,
	rateLimitCooldown,
} from "../src/core/credential-pool/classify.ts";

function status(code: number, message = `HTTP ${code}`): Error {
	const error = new Error(message);
	Object.assign(error, { status: code });
	return error;
}

describe("credential error taxonomy", () => {
	test.each([
		["401", status(401, "Unauthorized"), "failover", "auth_error"],
		["invalid api key", new Error("invalid api key provided"), "failover", "auth_error"],
		["403 with account code", status(403, "account suspended for this credential"), "failover", "auth_error"],
		["402 billing", status(402, "Payment Required"), "failover", "account_disabled"],
		["credits exhausted", new Error("billing: credits exhausted for this org"), "failover", "account_disabled"],
	] as const)("%s -> %s/%s", (_label, error, kind, reason) => {
		const action = classifyCredentialFailure(error);
		expect(action.kind).toBe(kind);
		if (action.kind === "failover") expect(action.block.reason).toBe(reason);
	});

	test("bare 403 fails the request instead of blocking a credential", () => {
		expect(classifyCredentialFailure(status(403, "Forbidden")).kind).toBe("fail_request");
	});

	test("429 fails over with an exponential cooldown", () => {
		const action = classifyCredentialFailure(status(429, "Too Many Requests"), { failureCount: 2 });
		expect(action.kind).toBe("failover");
		if (action.kind !== "failover" || action.block.reason !== "rate_limit") throw new Error("expected rate_limit");
		expect(action.block.cooldownMs).toBe(COOLDOWN_BASE_MS * 4);
		expect(action.block.retryAfterWasCapped).toBe(false);
	});

	test.each([
		["529", status(529, "overloaded")],
		["500", status(500, "Internal Server Error")],
		["503", status(503, "Service Unavailable")],
		["network", new Error("fetch failed: ECONNRESET")],
		["408", status(408, "Request Timeout")],
	] as const)("%s retries the same slot and never blocks the credential", (_label, error) => {
		const action = classifyCredentialFailure(error);
		expect(action).toEqual({ kind: "retry_same", maxAttempts: 2 });
	});

	test.each([
		["context overflow", new Error("prompt is too long: maximum context length exceeded")],
		["invalid model", new Error("model_not_found: no such model")],
		["400", status(400, "Bad Request")],
		["404", status(404, "Not Found")],
		["malformed stream", new Error("malformed stream frame")],
		["abort", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
		["unknown", new Error("something inexplicable happened")],
	] as const)("%s fails the request", (_label, error) => {
		expect(classifyCredentialFailure(error).kind).toBe("fail_request");
	});

	test("the server retry hint is a floor, not an override", () => {
		// A hint shorter than the earned backoff must not shorten the cooldown.
		expect(rateLimitCooldown(3, 1_000).cooldownMs).toBe(COOLDOWN_BASE_MS * 8);
		// A hint longer than the backoff lengthens it.
		expect(rateLimitCooldown(0, 300_000).cooldownMs).toBe(300_000);
		// Everything caps at 48h with the capping recorded.
		const capped = rateLimitCooldown(0, COOLDOWN_CAP_MS * 2);
		expect(capped.cooldownMs).toBe(COOLDOWN_CAP_MS);
		expect(capped.retryAfterWasCapped).toBe(true);
	});
});
