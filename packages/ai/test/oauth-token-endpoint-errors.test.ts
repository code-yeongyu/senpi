import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { chatgptSubscriptionOAuth } from "../src/auth/oauth/chatgpt-subscription.ts";
import { cursorOAuth } from "../src/auth/oauth/cursor.ts";
import { exchangeDevinAuthorizationCode } from "../src/auth/oauth/devin-token.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { openRouterOAuth } from "../src/auth/oauth/openrouter.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { OAuthAuth } from "../src/auth/types.ts";
import { createOpenGatewayCatalog } from "../src/providers/opengateway-refresh.ts";
import { classifyOAuthRefreshFailure } from "../src/utils/oauth-refresh-error.ts";

const credential = {
	type: "oauth" as const,
	access: "fixture-access",
	refresh: "fixture-refresh",
	expires: 1,
	clientId: "fixture-client",
};
const signal = new AbortController().signal;

describe("token endpoint HTTP error facts (#2893)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each([
		["anthropic", anthropicOAuth],
		["chatgpt-subscription", chatgptSubscriptionOAuth],
		["cursor", cursorOAuth],
		["github-copilot", githubCopilotOAuth],
		["kimi-coding", kimiCodingOAuth],
		["openai-chatgpt", openaiChatGPTOAuth],
		["radius", createRadiusOAuth({ name: "fixture", gateway: "https://fixture.example" })],
		["xai", xaiOAuth],
	] satisfies [string, OAuthAuth][])("%s retains HTTP status through refresh", async (_name, oauth) => {
		// 400 has no built-in provider delay and is a permanent rejection.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
		);
		const error = await oauth.refresh(credential, signal).catch((error: unknown) => error);
		const inner = error instanceof Error && error.cause ? error.cause : error;
		expect(inner).toMatchObject({ status: 400 });
		expect(classifyOAuthRefreshFailure(error)).toBe("permanent");
	});

	it.each([
		["anthropic", anthropicOAuth],
		["chatgpt-subscription", chatgptSubscriptionOAuth],
		["cursor", cursorOAuth],
		["github-copilot", githubCopilotOAuth],
		["kimi-coding", kimiCodingOAuth],
		["openai-chatgpt", openaiChatGPTOAuth],
		["radius", createRadiusOAuth({ name: "fixture", gateway: "https://fixture.example" })],
		["xai", xaiOAuth],
	] satisfies [string, OAuthAuth][])("%s keeps the refresh timeout as a transient cause", async (_name, oauth) => {
		// The shared refresh caps each exchange with AbortSignal.timeout; when it fires, fetch rejects
		// and the provider sees an aborted signal whose reason is the TimeoutError.
		const timedOut = new AbortController();
		const timeout = new DOMException("The operation timed out.", "TimeoutError");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				timedOut.abort(timeout);
				throw timeout;
			}),
		);
		const error = await oauth.refresh(credential, timedOut.signal).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect(classifyOAuthRefreshFailure(error)).toBe("transient");
	});

	it("xAI keeps the status of a non-JSON error page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>503 Service Unavailable</html>", { status: 503 })),
		);
		const error = await xaiOAuth.refresh(credential, signal).catch((error: unknown) => error);
		expect(classifyOAuthRefreshFailure(error)).toBe("transient");
	});

	it("Devin token exchange retains status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 503 })),
		);
		const error = await exchangeDevinAuthorizationCode("fixture-code", "fixture-verifier", signal).catch(
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ status: 503 });
		expect(classifyOAuthRefreshFailure(error)).toBe("transient");
	});

	it("OpenRouter key exchange retains status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 503 })),
		);
		const error = await openRouterOAuth
			.login({
				signal,
				prompt: async () => "fixture-code",
				notify: () => {},
			})
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ status: 503 });
		expect(classifyOAuthRefreshFailure(error)).toBe("transient");
	});

	it("OpenGateway catalog HTTP failure retains status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 503 })),
		);
		const catalog = createOpenGatewayCatalog([], undefined);
		const error = await catalog
			.refresh({ signal, allowNetwork: true, force: true, publish: async () => true })
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ status: 503 });
	});
});
