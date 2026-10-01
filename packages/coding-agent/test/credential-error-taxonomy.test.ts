import { describe, expect, test } from "vitest";
import {
	COOLDOWN_BASE_MS,
	COOLDOWN_CAP_MS,
	classifyCredentialFailure,
	rateLimitCooldown,
} from "../src/core/credential-pool/classify.ts";
import { allAccountsBlockedGuidance } from "../src/core/extensions/builtin/anthropic-subscription/guidance.ts";

// 2026-09-30 12:00 in Asia/Seoul, so reset prose resolves to fixed cooldowns.
// A zoneless reset reads as the host's local time, so its distance, and whether
// it passes the 48 h cap, depends on the zone the suite runs in.
const NOW_MS = Date.UTC(2026, 8, 30, 3, 0, 0);
const HOUR_MS = 3_600_000;
const FABLE_RESET_MS = new Date(2026, 9, 2, 9, 0, 0, 0).getTime() - NOW_MS;

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
		["codex usage limit", new Error("Codex error: The usage limit has been reached"), COOLDOWN_BASE_MS],
		[
			"claude session limit",
			new Error("You've hit your session limit \u00b7 resets 12am (Asia/Seoul)"),
			12 * HOUR_MS,
		],
		["weekly limit", new Error("You've hit your weekly limit \u00b7 resets 5am (Asia/Seoul)"), 17 * HOUR_MS],
	] as const)("%s fails over with a rate-limit cooldown", (_label, error, cooldownMs) => {
		// Subscription exhaustion reaches the pool as prose: no HTTP status, no
		// `rate limit` wording. Without this vocabulary the failure default-denies
		// to `fail_request`, so the exhausted credential is never blocked and the
		// healthy sibling is never attempted.
		const action = classifyCredentialFailure(error, { nowMs: NOW_MS });
		expect(action.kind).toBe("failover");
		if (action.kind !== "failover" || action.block.reason !== "rate_limit") throw new Error("expected rate_limit");
		// The cooldown runs until the account's own reset time when the text names one.
		expect(action.block.cooldownMs).toBe(cooldownMs);
	});

	test("overflow prose that names a limit still fails the request", () => {
		// The rate-limit branch runs BEFORE the overflow branch, so the subscription
		// vocabulary stays narrow: a provider that says `token limit` is reporting a
		// context overflow, and blocking a healthy credential for it is wrong.
		expect(classifyCredentialFailure(new Error("Your request exceeded model token limit: 262144")).kind).toBe(
			"fail_request",
		);
	});

	// Every account-scoped usage limit a supported provider is known to report as
	// text alone, verbatim from where senpi produces or has observed it. None of
	// these carries an HTTP status by the time the pool sees it (#1768).
	test.each([
		// openai-codex-responses.ts mapCodexEvents: an SSE `error` event becomes
		// `Codex error: <message || code>`; the message form is the #1768 report.
		["Codex SSE message", "Codex error: The usage limit has been reached"],
		["Codex SSE code only", "Codex error: usage_limit_reached"],
		["Codex SSE entitlement code only", "Codex error: usage_not_included"],
		// #1969: the hard-quota 429 body, as formatted into the message text.
		[
			"OpenAI hard-quota body",
			'OpenAI API error (429): {"type":"usage_limit_reached","message":"The usage limit has been reached"}',
		],
		// The bug watch re-confirmed both as fail_request on main (2026-09-30).
		["bare usage limit sentence", "The usage limit has been reached"],
		["reached your usage limit", "You've reached your usage limit"],
		// openai-codex-responses.ts parseErrorResponse without resets_at (the reset
		// form is in credential-pool-reset-cooldown.test.ts).
		["ChatGPT friendly message", "You have hit your ChatGPT usage limit (plus plan)."],
		// Claude Code subscription prose: #1768, anthropic-subscription-failover.test.ts,
		// retry-fallback-usage-limit.test.ts.
		["Claude session limit", "You've hit your session limit \u00b7 resets 12am (Asia/Seoul)", 12 * HOUR_MS],
		["Claude weekly limit", "You've hit your weekly limit \u00b7 resets 5am (Asia/Seoul)", 17 * HOUR_MS],
		["Claude 5-hour limit", "You've reached your 5-hour limit"],
		["Claude model weekly limit", "You've hit your Fable weekly limit \u00b7 resets Oct 2, 9am", FABLE_RESET_MS],
		// Claude Code terminal reasons (anthropic-subscription-failover.test.ts).
		["Claude blocking_limit", "Claude Code error_during_execution: blocking_limit"],
		["Claude rapid_refill_breaker", "Claude Code error_during_execution: rapid_refill_breaker"],
		// OpenCode Go / free-tier subscription limits (packages/ai utils/retry.ts).
		["OpenCode monthly limit", "Monthly usage limit reached"],
		["OpenCode Go limit", 'GoUsageLimitError: {"type":"GoUsageLimitError"}'],
		["OpenCode free-tier limit", 'FreeUsageLimitError: {"type":"FreeUsageLimitError"}'],
		// github-copilot-errors.ts describeGitHubCopilotFailure, quota branch.
		[
			"GitHub Copilot quota",
			"GitHub Copilot quota exceeded (HTTP 429): the plan's included usage or its additional-usage limit is used up, so premium models are refused until it resets or the limit is raised.",
		],
		// cursor-agent.test.ts: Cursor's Connect end-stream error (already covered).
		["Cursor resource_exhausted", "Connect error resource_exhausted: quota exceeded"],
	] as const)(
		"%s is an account usage limit: fails over with a rate-limit cooldown",
		(_label, message, cooldownMs?: number) => {
			expect(classifyCredentialFailure(new Error(message), { nowMs: NOW_MS })).toEqual({
				kind: "failover",
				block: {
					reason: "rate_limit",
					cooldownMs: Math.min(cooldownMs ?? COOLDOWN_BASE_MS, COOLDOWN_CAP_MS),
					retryAfterWasCapped: (cooldownMs ?? COOLDOWN_BASE_MS) > COOLDOWN_CAP_MS,
				},
			});
		},
	);

	// Text that names a limit but is not a spent account: each keeps the class it
	// has on main, so a healthy credential is never blocked for it.
	test.each([
		// retry-profile-classifiers.test.ts: a warning, not exhaustion.
		["approaching warning", "OpenAI API error (429): You are approaching your usage limit"],
		// overflow.ts catalogue (Kimi, Kiro): the request is too large.
		["Kimi token limit overflow", "Your request exceeded model token limit: 262144"],
		["Kiro context limit overflow", "Model context limit reached. Conversation size exceeds model capacity."],
		// retry-profile-classifiers.test.ts: NVIDIA NIM worker load, provider-side.
		["NIM worker request limit", "ResourceExhausted: Worker local total request limit reached (288/48)"],
		// anthropic-subscription errors.ts: a model entitlement, not a spent account.
		["Anthropic usage credits", "Usage credits are required for this model."],
	] as const)("%s is not an account usage limit: fails the request", (_label, message) => {
		expect(classifyCredentialFailure(new Error(message))).toEqual({ kind: "fail_request" });
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

	test("a status-less prose 401 credential rejection fails over instead of dead-ending the pool", () => {
		// opencode-go reports a rejected key inside the provider stream; the error
		// frame carries only this formatted message (AssistantMessage has no
		// numeric status field), so the text is the only signal classification gets.
		const rejection =
			'OpenAI API error (401): {"type":"server_error","message":"Upstream request failed: Invalid credential"}';
		expect(classifyCredentialFailure(new Error(rejection))).toEqual({
			kind: "failover",
			block: { reason: "auth_error" },
		});
	});

	test("an invalid-request body without credential wording still fails the request", () => {
		// Widening the credential-wording alternation must not swallow OpenAI's
		// generic `invalid_request_error` type used for malformed requests.
		expect(
			classifyCredentialFailure(
				new Error('{"type":"invalid_request_error","message":"Missing required parameter: input"}'),
			).kind,
		).toBe("fail_request");
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
