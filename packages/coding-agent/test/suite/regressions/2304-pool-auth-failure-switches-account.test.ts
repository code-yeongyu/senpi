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

function refreshUnavailable(cause: unknown): OAuthRefreshUnavailableError {
	return new OAuthRefreshUnavailableError(PROVIDER, cause);
}

function withDiagnostic(error: Error, diagnostic: ProviderDiagnostic): Error {
	return attachProviderDiagnostic(error, diagnostic);
}

describe("auth-class classification of one pooled account (senpi#2304, senpi#3037)", () => {
	test.each([
		["refresh grant rejected (400 invalid_grant)", () => refreshRejected(400, '{"error":"invalid_grant"}')],
		["refresh token expired (401)", () => refreshRejected(401, '{"error":{"code":"refresh_token_expired"}}')],
		["refresh token reused (401)", () => refreshRejected(401, '{"error":{"code":"refresh_token_reused"}}')],
		["refresh refused (403)", () => refreshRejected(403, "forbidden")],
		["statusless invalidated token prose", () => new Error(INVALIDATED)],
		["statusless revoked token prose", () => new Error("Your token has been revoked. Please sign in again.")],
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
	] as const)("%s never blocks the account: it retries the same account", (_label, error) => {
		expect(classifyCredentialFailure(error(), { nowMs: NOW })).toEqual({ kind: "retry_same", maxAttempts: 2 });
	});

	test("a 429 that names a revoked token stays a rate limit", () => {
		const action = classifyCredentialFailure(
			Object.assign(new Error("rate limited; token revoked soon"), { status: 429 }),
			{ nowMs: NOW },
		);
		expect(action).toMatchObject({ kind: "failover", block: { reason: "rate_limit" } });
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
