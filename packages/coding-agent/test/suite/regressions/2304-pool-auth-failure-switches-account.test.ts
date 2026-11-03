import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent, ProviderDiagnostic } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error";
import { OAuthRefreshUnavailableError, OAuthTokenEndpointError } from "@earendil-works/pi-ai/utils/oauth-refresh-error";
import { attachProviderDiagnostic } from "@earendil-works/pi-ai/utils/provider-diagnostic-carrier";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { classifyCredentialFailure } from "../../../src/core/credential-pool/classify.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#2304 / senpi#3037: an auth failure of ONE pooled account (its refresh grant rejected, its
// access token revoked or invalidated server-side, with or without an HTTP status) blocks that
// account as auth_error and moves the request to a sibling before any output. A transient
// token-endpoint failure (network, 5xx) never blocks the account.

const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const PROVIDER = "fixture-pool";
const INVALIDATED = "Encountered invalidated oauth token for user, failing request";

function refreshRejected(status: number, body: string): ModelsError {
	return new ModelsError("oauth", `OAuth refresh failed for ${PROVIDER}`, {
		cause: new OAuthTokenEndpointError(`token refresh failed (${status}): ${body}`, status),
	});
}

function refreshFailed(cause: unknown): ModelsError {
	return new ModelsError("oauth", `OAuth refresh failed for ${PROVIDER}`, { cause });
}

function refreshUnavailable(cause: unknown): OAuthRefreshUnavailableError {
	return new OAuthRefreshUnavailableError(PROVIDER, cause);
}

function withDiagnostic(error: Error, diagnostic: ProviderDiagnostic): Error {
	return attachProviderDiagnostic(error, diagnostic);
}

// One table for the whole refresh-failure class: a token endpoint's 401 is an account verdict;
// other statuses need a refused-grant body before the account can be blocked.
describe("a failed OAuth refresh blocks the account only when the grant itself was refused", () => {
	const FAILOVER = { kind: "failover", block: { reason: "auth_error" } };
	const FAIL_REQUEST = { kind: "fail_request" };
	test.each([
		["401 plain", () => refreshRejected(401, "Unauthorized"), FAILOVER],
		[
			"401 Copilot Bad credentials",
			() => refreshFailed(new OAuthTokenEndpointError('401 Unauthorized: {"message":"Bad credentials"}', 401)),
			FAILOVER,
		],
		["401 RFC 6749 invalid_grant", () => refreshRejected(401, '{"error":"invalid_grant"}'), FAILOVER],
		[
			"400 invalid_grant",
			() => refreshRejected(400, '{"error":"invalid_grant","error_description":"Refresh token expired"}'),
			FAILOVER,
		],
		["401 refresh_token_expired", () => refreshRejected(401, '{"error":{"code":"refresh_token_expired"}}'), FAILOVER],
		["401 refresh_token_reused", () => refreshRejected(401, '{"error":{"code":"refresh_token_reused"}}'), FAILOVER],
		[
			"401 refresh_token_invalidated",
			() => refreshRejected(401, '{"error":{"code":"refresh_token_invalidated"}}'),
			FAILOVER,
		],
		[
			"401 token_revoked",
			() => refreshRejected(401, '{"error":{"message":"revoked","code":"token_revoked"}}'),
			FAILOVER,
		],
		[
			"400 form-encoded invalid_grant",
			() => refreshRejected(400, "error=invalid_grant&error_description=expired"),
			FAILOVER,
		],
		["403 with an OAuth invalid_grant body", () => refreshRejected(403, '{"error":"invalid_grant"}'), FAILOVER],
		["404 with an OAuth invalid_grant body", () => refreshRejected(404, '{"error":"invalid_grant"}'), FAILOVER],
		["403 non-refusal OAuth body", () => refreshRejected(403, '{"error":"invalid_request"}'), FAIL_REQUEST],
		["404 non-refusal OAuth body", () => refreshRejected(404, '{"error":"invalid_request"}'), FAIL_REQUEST],
		["403 refusal code outside OAuth JSON", () => refreshRejected(403, "error=invalid_grant"), FAIL_REQUEST],
		["404 refusal code outside OAuth JSON", () => refreshRejected(404, "error=invalid_grant"), FAIL_REQUEST],
		["statusless refusal wording", () => refreshFailed(new Error('{"error":"invalid_grant"}')), FAIL_REQUEST],
		[
			"TLS interception (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)",
			() =>
				refreshFailed(
					Object.assign(new TypeError("fetch failed"), {
						cause: Object.assign(new Error("unable to get local issuer certificate"), {
							code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
						}),
					}),
				),
			FAIL_REQUEST,
		],
		[
			"captive portal HTML 200 (SyntaxError from response.json())",
			() => refreshFailed(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")),
			FAIL_REQUEST,
		],
		[
			"403 WAF challenge page",
			() => refreshRejected(403, "<html><title>Unauthorized</title>Access denied by firewall</html>"),
			FAIL_REQUEST,
		],
		["404 token endpoint moved", () => refreshRejected(404, "Not Found"), FAIL_REQUEST],
		["403 plain forbidden", () => refreshRejected(403, "forbidden"), FAIL_REQUEST],
		["400 that names no grant error", () => refreshRejected(400, '{"error":"invalid_request"}'), FAIL_REQUEST],
		// A 401 naming a fault of the client application or the request (RFC 6749 section 5.2) is the same
		// for every account, so it never blocks one; a 401 naming no OAuth code still does.
		...["invalid_client", "unauthorized_client", "invalid_request", "unsupported_grant_type", "invalid_scope"].map(
			(code) => [`401 ${code}`, () => refreshRejected(401, JSON.stringify({ error: code })), FAIL_REQUEST] as const,
		),
		[
			"401 invalid_client carried as the error's OAuth code",
			() =>
				refreshFailed(new OAuthTokenEndpointError("token refresh failed", 401, { oauthError: "invalid_client" })),
			FAIL_REQUEST,
		],
		// Kimi's refresh decides the refusal itself and throws prose with no OAuth JSON
		// ("Kimi Code token refresh unauthorized (status N): <description>"), carrying the facts on the error.
		[
			"Kimi 403 refusal",
			() =>
				refreshFailed(
					new OAuthTokenEndpointError("Kimi Code token refresh unauthorized (status 403): token revoked", 403, {
						credentialRefused: true,
					}),
				),
			FAILOVER,
		],
		[
			"Kimi 400 invalid_grant refusal",
			() =>
				refreshFailed(
					new OAuthTokenEndpointError(
						"Kimi Code token refresh unauthorized (status 400): The refresh token is invalid",
						400,
						{ oauthError: "invalid_grant", credentialRefused: true },
					),
				),
			FAILOVER,
		],
		[
			"Kimi 401 invalid_client is a client fault, not a refusal",
			() =>
				refreshFailed(
					new OAuthTokenEndpointError("Kimi Code token refresh unauthorized (status 401): bad client", 401, {
						oauthError: "invalid_client",
						credentialRefused: true,
					}),
				),
			FAIL_REQUEST,
		],
		[
			"a token that expires too soon after refresh",
			() => new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${PROVIDER}`),
			FAIL_REQUEST,
		],
	] as const)("%s", (_label, error, expected) => {
		expect(classifyCredentialFailure(error(), { nowMs: NOW })).toEqual(expected);
	});
});

// A refresh that never reached the token endpoint says nothing about the account: it retries the same
// account like any model request with the same transport fault, whichever network code reports it.
describe("a refresh that failed in the network retries the same account", () => {
	const RETRY_SAME = { kind: "retry_same", maxAttempts: 2 };
	const NETWORK_CODES = [
		"ECONNRESET",
		"ECONNREFUSED",
		"ECONNABORTED",
		"ETIMEDOUT",
		"EHOSTUNREACH",
		"EHOSTDOWN",
		"ENETUNREACH",
		"ENETDOWN",
		"ENETRESET",
		"ENOTFOUND",
		"EAI_AGAIN",
		"EPIPE",
		"EADDRNOTAVAIL",
		"ERR_SOCKET_CONNECTION_TIMEOUT",
		"UND_ERR_CONNECT_TIMEOUT",
		"UND_ERR_HEADERS_TIMEOUT",
		"UND_ERR_BODY_TIMEOUT",
		"UND_ERR_SOCKET",
		"UND_ERR_CLOSED",
		"ConnectionRefused",
		"ConnectionClosed",
		"FailedToOpenSocket",
	];
	test.each(NETWORK_CODES)("undici fetch failed caused by %s", (code) => {
		const cause = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error(`connect ${code} 192.0.2.1:443`), { code }),
		});
		expect(classifyCredentialFailure(refreshFailed(cause), { nowMs: NOW })).toEqual(RETRY_SAME);
	});
	test.each(NETWORK_CODES)("runtime socket error with code %s", (code) => {
		const cause = Object.assign(new Error("Unable to connect"), { code });
		expect(classifyCredentialFailure(refreshFailed(cause), { nowMs: NOW })).toEqual(RETRY_SAME);
	});
	test.each(["fetch failed", "socket hang up", "network error", "request timed out", "read ECONNRESET"])(
		"statusless network wording: %s",
		(text) => {
			expect(classifyCredentialFailure(refreshFailed(new Error(text)), { nowMs: NOW })).toEqual(RETRY_SAME);
		},
	);
	test("a refresh that hit a local certificate fault still fails the request", () => {
		const cause = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
				code: "SELF_SIGNED_CERT_IN_CHAIN",
			}),
		});
		expect(classifyCredentialFailure(refreshFailed(cause), { nowMs: NOW })).toEqual({ kind: "fail_request" });
	});
	test("a token endpoint that answered is not a network fault, whatever its page says", () => {
		const error = refreshRejected(403, "<html>network error: request blocked by firewall</html>");
		expect(classifyCredentialFailure(error, { nowMs: NOW })).toEqual({ kind: "fail_request" });
	});
	test("network wording in a refused grant still blocks the account", () => {
		const error = refreshRejected(401, '{"error":"invalid_grant","error_description":"network error"}');
		expect(classifyCredentialFailure(error, { nowMs: NOW })).toEqual({
			kind: "failover",
			block: { reason: "auth_error" },
		});
	});
	test("auth wording in a failed refresh that was not refused never blocks the account", () => {
		const error = refreshFailed(new Error("unauthorized: invalid api key, token revoked"));
		expect(classifyCredentialFailure(error, { nowMs: NOW })).toEqual({ kind: "fail_request" });
	});
});

describe("auth-class classification of one pooled account (senpi#2304, senpi#3037)", () => {
	test.each([
		["statusless invalidated token prose", () => new Error(INVALIDATED)],
		["statusless revoked token prose", () => new Error("Your token has been revoked. Please sign in again.")],
		["statusless revoked access token prose", () => new Error("access token revoked")],
		["statusless token_invalidated prose", () => new Error("error: token_invalidated")],
		[
			"statusless structured token_revoked code",
			() =>
				withDiagnostic(new Error("Codex error: request failed"), {
					category: "unknown",
					code: "token_revoked",
					evidence: "structured_code",
				}),
		],
		[
			"statusless structured token_invalidated code",
			() =>
				withDiagnostic(new Error("Codex error: request failed"), {
					category: "unknown",
					code: "token_invalidated",
					evidence: "structured_code",
				}),
		],
		[
			"statusless structured authentication_error code",
			() =>
				withDiagnostic(new Error("stream error"), {
					category: "auth",
					code: "authentication_error",
					evidence: "structured_code",
				}),
		],
	] as const)("%s blocks the account as auth_error and fails over", (_label, error) => {
		expect(classifyCredentialFailure(error(), { nowMs: NOW })).toEqual({
			kind: "failover",
			block: { reason: "auth_error" },
		});
	});

	test.each([
		["refresh endpoint 503", () => refreshUnavailable(new OAuthTokenEndpointError("unavailable", 503))],
		["refresh endpoint 429", () => refreshUnavailable(new OAuthTokenEndpointError("slow down", 429))],
		[
			"refresh connection refused",
			() => refreshUnavailable(Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" })),
		],
		["provider 503 echoing invalidated token text", () => Object.assign(new Error(INVALIDATED), { status: 503 })],
		[
			"refresh 503 whose body names invalid_grant",
			() =>
				refreshUnavailable(
					new OAuthTokenEndpointError('token refresh failed (503): {"error":"invalid_grant"}', 503),
				),
		],
	] as const)("%s never blocks the account: it retries the same account", (_label, error) => {
		expect(classifyCredentialFailure(error(), { nowMs: NOW })).toEqual({ kind: "retry_same", maxAttempts: 2 });
	});

	test.each([
		["websocket session was invalidated, reconnect", "fail_request"],
		["websocket session has been revoked, reconnect", "fail_request"],
		["WebSocket error: session was invalidated", "retry_same"],
		["WebSocket closed 1006: session has been revoked", "retry_same"],
		["session token invalidated", "fail_request"],
		["session_token_revoked", "fail_request"],
		["session token has been revoked", "fail_request"],
		["csrf token invalidated", "fail_request"],
		["pagination token was invalidated", "fail_request"],
		["continuation token revoked", "fail_request"],
		["cursor token invalidated", "fail_request"],
		["idempotency token revoked", "fail_request"],
	] as const)("%s is not evidence of a revoked credential", (text, kind) => {
		expect(classifyCredentialFailure(new Error(text), { nowMs: NOW })).toEqual(
			kind === "retry_same" ? { kind, maxAttempts: 2 } : { kind },
		);
	});

	test.each([
		["unknown", "token_revoked"],
		["unknown", "token_invalidated"],
		["auth", "authentication_error"],
	] as const)("%s / %s diagnostic does not override a statusless transport failure", (category, code) => {
		for (const text of ["fetch failed: ECONNRESET", "request timed out", "network error"]) {
			const error = withDiagnostic(new Error(text), { category, code, evidence: "structured_code" });
			expect(classifyCredentialFailure(error, { nowMs: NOW }), text).toEqual({
				kind: "retry_same",
				maxAttempts: 2,
			});
		}
	});

	test("an explicit 401 still refuses the account even when its message mentions a network error", () => {
		const error = withDiagnostic(Object.assign(new Error("network error: unauthorized"), { status: 401 }), {
			category: "auth",
			code: "authentication_error",
			evidence: "structured_code",
		});
		expect(classifyCredentialFailure(error, { nowMs: NOW })).toEqual({
			kind: "failover",
			block: { reason: "auth_error" },
		});
	});

	test("a 429 that names a revoked token stays a rate limit", () => {
		const action = classifyCredentialFailure(
			Object.assign(new Error("rate limited; token revoked soon"), { status: 429 }),
			{ nowMs: NOW },
		);
		expect(action).toMatchObject({ kind: "failover", block: { reason: "rate_limit" } });
	});

	test("a statusless token_expired code does not block: an expired but refreshable token must refresh", () => {
		const error = withDiagnostic(new Error("Codex error: request failed"), {
			category: "unknown",
			code: "token_expired",
			evidence: "structured_code",
		});
		expect(classifyCredentialFailure(error, { nowMs: NOW })).toEqual({ kind: "fail_request" });
	});

	test("an unrelated statusless request error still fails the request", () => {
		expect(classifyCredentialFailure(new Error("invalid tool arguments for edit"), { nowMs: NOW })).toEqual({
			kind: "fail_request",
		});
	});
});

describe("the rotation stream switches off a pooled account with an auth failure (senpi#2304, senpi#3037)", () => {
	let dir: string;
	let repository: CredentialSlotRepository;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-2304-pool-"));
		repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function pool(pinned?: string): PooledCredential {
		return {
			type: "oauth",
			access: "managed",
			refresh: "managed",
			expires: NOW + 86_400_000,
			accounts: [
				{ name: "alpha", access: "alpha-access", refresh: "alpha-refresh", source: "login" },
				{ name: "bravo", access: "bravo-access", refresh: "bravo-refresh", source: "login" },
			],
			...(pinned === undefined ? {} : { pinned }),
		};
	}

	function message(errorMessage?: string, providerDiagnostic?: ProviderDiagnostic): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: PROVIDER,
			model: "fixture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: errorMessage === undefined ? "stop" : "error",
			...(errorMessage === undefined ? {} : { errorMessage }),
			...(providerDiagnostic === undefined ? {} : { providerDiagnostic }),
			timestamp: NOW,
		};
	}

	async function* served(): AsyncGenerator<AssistantMessageEvent> {
		yield { type: "start", partial: message() };
		yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: message() };
		yield { type: "done", reason: "stop", message: message() };
	}

	async function* failed(text: string, diagnostic?: ProviderDiagnostic): AsyncGenerator<AssistantMessageEvent> {
		yield { type: "start", partial: message() };
		yield { type: "error", reason: "error", error: message(text, diagnostic) };
	}

	type Failure = (
		slot: string,
	) => AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>;

	async function request(credential: PooledCredential, alpha: Failure, attempts: string[]) {
		const events: AssistantMessageEvent[] = [];
		const stream = streamWithCredentialRotation({
			sources: {
				providerId: PROVIDER,
				credential,
				env: () => undefined,
				repository,
				policy: { affinity: false },
				now: () => NOW,
			},
			affinityKey: "session-2304",
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return slot.name === "alpha" ? alpha(slot.name) : served();
			},
		});
		for await (const event of stream) events.push(event);
		return events;
	}

	async function health(name: string) {
		return (await repository.listSlots(PROVIDER, "stored"))[name];
	}

	test.each([
		[
			"its refresh grant was rejected",
			async () => {
				throw refreshRejected(400, '{"error":"invalid_grant"}');
			},
		],
		["its token was invalidated server-side (no status)", () => failed(INVALIDATED)],
		[
			"the provider names token_revoked in a statusless frame",
			() =>
				failed("Codex error: request failed", {
					category: "unknown",
					code: "token_revoked",
					evidence: "structured_code",
				}),
		],
	] as const)(
		"the pinned account %s: the sibling serves before any output and the account is blocked",
		async (_label, alpha) => {
			const attempts: string[] = [];

			const events = await request(pool("alpha"), alpha, attempts);

			expect(attempts).toEqual(["alpha", "bravo"]);
			expect(events.at(-1)?.type).toBe("done");
			expect(events.filter((event) => event.type === "start")).toHaveLength(1);
			expect(await health("alpha")).toMatchObject({ blockReason: "auth_error" });
			expect((await health("alpha"))?.blockedUntil).toBeGreaterThan(NOW);

			// The pin keeps naming the dead account, but its block keeps later requests off it.
			const next: string[] = [];
			await request(pool("alpha"), alpha, next);
			expect(next).toEqual(["bravo"]);
		},
	);

	test("a transient refresh failure retries the same account and never blocks it", async () => {
		const attempts: string[] = [];
		let calls = 0;

		const events = await request(
			pool("alpha"),
			async () => {
				calls += 1;
				if (calls === 1) throw refreshUnavailable(new OAuthTokenEndpointError("unavailable", 503));
				return served();
			},
			attempts,
		);

		expect(attempts).toEqual(["alpha", "alpha"]);
		expect(events.at(-1)?.type).toBe("done");
		expect((await health("alpha"))?.blockReason).toBeUndefined();
	});
});
