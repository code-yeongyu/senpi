import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorOAuth } from "../src/auth/oauth/cursor.ts";
import type { AuthEvent, OAuthCredential } from "../src/auth/types.ts";
import { builtinProviders } from "../src/providers/all.ts";

const neverAbortedSignal = new AbortController().signal;

const POLL_URL = "https://api2.cursor.sh/auth/poll";
const REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

function base64url(value: string): string {
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Unsigned JWT with the given payload — enough for expiry-claim parsing. */
function fakeJwt(payload: Record<string, unknown>): string {
	return `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(JSON.stringify(payload))}.sig`;
}

async function sha256Base64url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	let binary = "";
	for (const byte of new Uint8Array(digest)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function loginCursorForTest(options?: {
	signal?: AbortSignal;
	onEvent?: (event: AuthEvent) => void;
}): Promise<OAuthCredential> {
	return cursorOAuth.login({
		signal: options?.signal ?? neverAbortedSignal,
		prompt: () => {
			throw new Error("Unexpected prompt");
		},
		notify: (event) => options?.onEvent?.(event),
	});
}

function refreshCursorForTest(refreshToken: string): Promise<OAuthCredential> {
	return cursorOAuth.refresh(
		{ type: "oauth", access: "old-access", refresh: refreshToken, expires: 0 },
		neverAbortedSignal,
	);
}

/**
 * Fakes only what the flow uses (`setTimeout`/`clearTimeout` for the poll
 * sleep, `Date` for expiry math) so `setImmediate` stays real and
 * {@link flushUntilPollScheduled} can yield genuine event-loop turns.
 */
function useCursorFakeTimers(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/**
 * login() awaits real (threadpool) crypto for PKCE before scheduling its
 * first poll sleep; each real event-loop turn lets that crypto complete, so
 * subsequent fake-timer advances are deterministic even when the whole suite
 * runs in parallel.
 */
async function flushUntilPollScheduled(): Promise<void> {
	for (let i = 0; i < 2000; i++) {
		if (vi.getTimerCount() > 0) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("Login never scheduled its first poll");
}

describe("Cursor OAuth login", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("opens the deep-control URL with a valid PKCE challenge and polls until the tokens release", async () => {
		useCursorFakeTimers();
		const startTime = new Date("2026-08-16T12:00:00Z");
		vi.setSystemTime(startTime);
		const accessJwt = fakeJwt({ sub: "auth0|user_123", exp: Math.floor(startTime.getTime() / 1000) + 3600 });
		const pollTimes: number[] = [];
		const pollUrls: string[] = [];
		const pollReplies = [
			jsonResponse({ error: "not found" }, 404),
			jsonResponse({ error: "not found" }, 404),
			jsonResponse({ accessToken: accessJwt, refreshToken: "refresh-1" }),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = requestUrl(input);
				if (!url.startsWith(POLL_URL)) throw new Error(`Unexpected request: ${url}`);
				pollTimes.push(Date.now());
				pollUrls.push(url);
				const reply = pollReplies.shift();
				if (!reply) throw new Error("Unexpected poll");
				return reply;
			}),
		);

		const events: AuthEvent[] = [];
		const loginPromise = loginCursorForTest({ onEvent: (event) => events.push(event) });

		await flushUntilPollScheduled();
		const authUrlEvent = events.find((event) => event.type === "auth_url");
		if (authUrlEvent?.type !== "auth_url") throw new Error("Expected an auth_url event");
		const loginUrl = new URL(authUrlEvent.url);
		expect(loginUrl.origin + loginUrl.pathname).toBe("https://cursor.com/loginDeepControl");
		expect(loginUrl.searchParams.get("mode")).toBe("login");
		expect(loginUrl.searchParams.get("redirectTarget")).toBe("cli");
		const challenge = loginUrl.searchParams.get("challenge");
		const uuid = loginUrl.searchParams.get("uuid");
		expect(challenge).toBeTruthy();
		expect(uuid).toBeTruthy();
		expect(events.some((event) => event.type === "progress")).toBe(true);
		expect(pollTimes).toEqual([]);

		// Backoff: 1000ms, then 1200ms, then 1440ms.
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1200);
		await vi.advanceTimersByTimeAsync(1440);
		const credential = await loginPromise;

		expect(pollTimes).toEqual([startTime.getTime() + 1000, startTime.getTime() + 2200, startTime.getTime() + 3640]);
		for (const url of pollUrls) {
			const parsed = new URL(url);
			expect(parsed.searchParams.get("uuid")).toBe(uuid);
			// The poll verifier must be the PKCE preimage of the challenge in the login URL.
			expect(await sha256Base64url(parsed.searchParams.get("verifier") ?? "")).toBe(challenge);
		}

		expect(credential).toEqual({
			type: "oauth",
			access: accessJwt,
			refresh: "refresh-1",
			expires: startTime.getTime() + 3600_000 - 300_000,
		});
	});

	it("fails fast when the poll endpoint definitively rejects the login", async () => {
		useCursorFakeTimers();
		const pollReplies = [
			jsonResponse({ error: "not found" }, 404),
			jsonResponse({ error: "invalid_request", error_description: "challenge mismatch" }, 401),
		];
		const fetchMock = vi.fn(async () => {
			const reply = pollReplies.shift();
			if (!reply) throw new Error("Unexpected poll");
			return reply;
		});
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginCursorForTest();
		const failure = expect(loginPromise).rejects.toThrow(
			"Cursor login was rejected (HTTP 401: invalid_request: challenge mismatch)",
		);
		await flushUntilPollScheduled();
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1200);
		await failure;
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("tolerates transient network errors between pending polls", async () => {
		useCursorFakeTimers();
		const accessJwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
		const pollReplies: (Response | Error)[] = [
			new Error("socket hang up"),
			jsonResponse({ error: "not found" }, 404),
			new Error("socket hang up"),
			new Error("socket hang up"),
			jsonResponse({ error: "not found" }, 404),
			jsonResponse({ accessToken: accessJwt, refreshToken: "refresh-1" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const reply = pollReplies.shift();
				if (!reply) throw new Error("Unexpected poll");
				if (reply instanceof Error) throw reply;
				return reply;
			}),
		);

		const loginPromise = loginCursorForTest();
		await flushUntilPollScheduled();
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(10_000);
		}
		const credential = await loginPromise;
		expect(credential.refresh).toBe("refresh-1");
	});

	it("gives up after three consecutive network errors", async () => {
		useCursorFakeTimers();
		const fetchMock = vi.fn(async () => {
			throw new Error("socket hang up");
		});
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginCursorForTest();
		const failure = expect(loginPromise).rejects.toThrow(
			"Cursor login polling failed after repeated network errors: socket hang up",
		);
		await flushUntilPollScheduled();
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(10_000);
		}
		await failure;
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("gives up after three consecutive server errors and reports the status", async () => {
		useCursorFakeTimers();
		const fetchMock = vi.fn(async () => jsonResponse({ message: "internal" }, 500));
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginCursorForTest();
		const failure = expect(loginPromise).rejects.toThrow("Cursor login polling failed (HTTP 500: internal)");
		await flushUntilPollScheduled();
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(10_000);
		}
		await failure;
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps polling through rate limits without burning the transient failure budget", async () => {
		useCursorFakeTimers();
		const accessJwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
		const pollReplies = [
			jsonResponse({}, 429),
			jsonResponse({}, 429),
			jsonResponse({}, 429),
			jsonResponse({}, 429),
			jsonResponse({ accessToken: accessJwt, refreshToken: "refresh-1" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const reply = pollReplies.shift();
				if (!reply) throw new Error("Unexpected poll");
				return reply;
			}),
		);

		const loginPromise = loginCursorForTest();
		await flushUntilPollScheduled();
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(10_000);
		}
		const credential = await loginPromise;
		expect(credential.access).toBe(accessJwt);
	});

	it("cancels cleanly when the login is aborted while waiting", async () => {
		useCursorFakeTimers();
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "not found" }, 404)),
		);

		const loginPromise = loginCursorForTest({ signal: controller.signal });
		const failure = expect(loginPromise).rejects.toThrow("Login cancelled");
		await flushUntilPollScheduled();
		await vi.advanceTimersByTimeAsync(1000);
		controller.abort();
		await failure;
	});

	it("times out after the poll attempt budget is exhausted", async () => {
		useCursorFakeTimers();
		const fetchMock = vi.fn(async () => jsonResponse({ error: "not found" }, 404));
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginCursorForTest();
		const failure = expect(loginPromise).rejects.toThrow("Cursor login timed out waiting for browser approval");
		await flushUntilPollScheduled();
		await vi.runAllTimersAsync();
		await failure;
		expect(fetchMock).toHaveBeenCalledTimes(150);
	});

	it("rejects a token release with missing fields", async () => {
		useCursorFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ accessToken: "only-access" })),
		);

		const loginPromise = loginCursorForTest();
		const failure = expect(loginPromise).rejects.toThrow("Invalid Cursor OAuth response field: refreshToken");
		await flushUntilPollScheduled();
		await vi.advanceTimersByTimeAsync(1000);
		await failure;
	});

	it("falls back to a one-hour lifetime when the access token is not a readable JWT", async () => {
		useCursorFakeTimers();
		const startTime = new Date("2026-08-16T12:00:00Z");
		vi.setSystemTime(startTime);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ accessToken: "opaque-token", refreshToken: "refresh-1" })),
		);

		const loginPromise = loginCursorForTest();
		await flushUntilPollScheduled();
		await vi.advanceTimersByTimeAsync(1000);
		const credential = await loginPromise;
		expect(credential.expires).toBe(startTime.getTime() + 1000 + 3600_000 - 300_000);
	});
});

describe("Cursor OAuth refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("exchanges the refresh token as a bearer and applies the rotated pair", async () => {
		const now = Date.now();
		const accessJwt = fakeJwt({ exp: Math.floor(now / 1000) + 7200 });
		let capturedInit: RequestInit | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				expect(requestUrl(input)).toBe(REFRESH_URL);
				capturedInit = init;
				return jsonResponse({ accessToken: accessJwt, refreshToken: "rotated-refresh" });
			}),
		);

		const credential = await refreshCursorForTest("old-refresh");
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.body).toBe("{}");
		expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer old-refresh");
		expect(credential.access).toBe(accessJwt);
		expect(credential.refresh).toBe("rotated-refresh");
		expect(credential.expires).toBeGreaterThan(now);
	});

	it("keeps the previous refresh token when the server does not rotate it", async () => {
		const accessJwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 });
		for (const refreshField of [undefined, ""]) {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse({ accessToken: accessJwt, refreshToken: refreshField })),
			);
			const credential = await refreshCursorForTest("old-refresh");
			expect(credential.refresh).toBe("old-refresh");
		}
	});

	it("fails with the server detail on rejection without echoing the token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 401)),
		);

		const failure = refreshCursorForTest("secret-refresh-token");
		await expect(failure).rejects.toThrow("Cursor token refresh failed (HTTP 401: invalid_grant)");
		await expect(refreshCursorForTest("secret-refresh-token")).rejects.not.toThrow(/secret-refresh-token/);
	});

	it("fails when the response is not JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>gateway error</html>", { status: 502 })),
		);

		await expect(refreshCursorForTest("old-refresh")).rejects.toThrow("Cursor token refresh failed (HTTP 502)");
	});

	it("refuses to refresh without a stored refresh token", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(refreshCursorForTest("")).rejects.toThrow(
			"Cursor token refresh failed: no refresh token stored; run login again",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a refresh response with a missing access token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ refreshToken: "rotated" })),
		);

		await expect(refreshCursorForTest("old-refresh")).rejects.toThrow(
			"Invalid Cursor OAuth response field: accessToken",
		);
	});
});

describe("Cursor OAuth adapter", () => {
	it("derives the api key from the access token", async () => {
		const auth = await cursorOAuth.toAuth({ type: "oauth", access: "token", refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: "token" });
	});

	it("is a subscription flow", () => {
		expect(cursorOAuth.isSubscription).toBe(true);
	});

	it("registers the builtin provider as OAuth-only with no models yet", () => {
		const provider = builtinProviders().find((entry) => entry.id === "cursor");
		expect(provider).toBeDefined();
		expect(provider?.auth.oauth).toBeDefined();
		expect(provider?.auth.apiKey).toBeUndefined();
		expect(provider?.getModels()).toEqual([]);
	});
});
