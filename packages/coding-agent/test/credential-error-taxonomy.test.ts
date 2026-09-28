import { describe, expect, test } from "vitest";
import {
	COOLDOWN_BASE_MS,
	COOLDOWN_CAP_MS,
	classifyCredentialFailure,
	rateLimitCooldown,
} from "../src/core/credential-pool/classify.ts";
import { allAccountsBlockedGuidance } from "../src/core/extensions/builtin/anthropic-subscription/guidance.ts";

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
		["codex usage limit", new Error("Codex error: The usage limit has been reached")],
		["claude session limit", new Error("You've hit your session limit \u00b7 resets 12am (Asia/Seoul)")],
		["weekly limit", new Error("You've hit your weekly limit \u00b7 resets 5am (Asia/Seoul)")],
	] as const)("%s fails over with a rate-limit cooldown", (_label, error) => {
		// Subscription exhaustion reaches the pool as prose: no HTTP status, no
		// `rate limit` wording. Without this vocabulary the failure default-denies
		// to `fail_request`, so the exhausted credential is never blocked and the
		// healthy sibling is never attempted.
		const action = classifyCredentialFailure(error);
		expect(action.kind).toBe("failover");
		if (action.kind !== "failover" || action.block.reason !== "rate_limit") throw new Error("expected rate_limit");
		expect(action.block.cooldownMs).toBe(COOLDOWN_BASE_MS);
	});

	test("overflow prose that names a limit still fails the request", () => {
		// The rate-limit branch runs BEFORE the overflow branch, so the subscription
		// vocabulary stays narrow: a provider that says `token limit` is reporting a
		// context overflow, and blocking a healthy credential for it is wrong.
		expect(classifyCredentialFailure(new Error("Your request exceeded model token limit: 262144")).kind).toBe(
			"fail_request",
		);
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
		["abnormal closure 1006", new Error("WebSocket closed 1006 Connection ended")],
		["going away 1001", new Error("WebSocket closed 1001")],
		["server error 1011", new Error("WebSocket closed 1011 internal error")],
		["service restart 1012", new Error("WebSocket closed 1012")],
		["try again later 1013", new Error("WebSocket closed 1013")],
		["bad gateway 1014", new Error("WebSocket closed 1014")],
		["bare websocket error", new Error("WebSocket error")],
		["connect timeout", new Error("WebSocket connect timeout after 15000ms")],
		["liveness timeout", new Error("WebSocket liveness timeout after 70000ms (2 pings unanswered)")],
	] as const)("%s is a transport fault: retries the same slot without blocking it (senpi#1628)", (_label, error) => {
		expect(classifyCredentialFailure(error)).toEqual({ kind: "retry_same", maxAttempts: 2 });
	});

	test.each([
		["message too big 1009", new Error("WebSocket closed 1009 message too big")],
		["policy violation 1008", new Error("WebSocket closed 1008 policy violation")],
	] as const)("%s is a request fault: fails the request instead of replaying it", (_label, error) => {
		expect(classifyCredentialFailure(error).kind).toBe("fail_request");
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

	test("an unconfigured-slot auth miss fails over instead of dead-ending the pool", () => {
		// `Provider is not configured: <provider>` is what prepareRequest throws
		// when the slot the rotation picked carries no usable auth (the sentinel
		// slots a shipped bug wrote). One such slot must block ITSELF and let the
		// pool try the healthy siblings, not fail the request.
		const action = classifyCredentialFailure(new Error("Provider is not configured: anthropic-subscription"));
		expect(action).toEqual({ kind: "failover", block: { reason: "auth_error" } });
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

	test("lane all-blocked guidance for an auth-dominated pool classifies as auth_error, not rate_limit (omo#8383)", () => {
		const action = classifyCredentialFailure(new Error(allAccountsBlockedGuidance(undefined, "auth_error")));
		expect(action).toEqual({ kind: "failover", block: { reason: "auth_error" } });
	});

	test("lane all-blocked guidance without an auth block stays a rate-limit cooldown", () => {
		const action = classifyCredentialFailure(new Error(allAccountsBlockedGuidance(undefined)));
		expect(action.kind).toBe("failover");
		if (action.kind === "failover") expect(action.block.reason).toBe("rate_limit");
	});
});
