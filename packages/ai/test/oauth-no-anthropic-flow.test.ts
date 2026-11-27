/**
 * senpi#4436 (S7): Claude sign-in runs through the bundled Claude Code CLI, so senpi ships no Anthropic OAuth
 * flow of its own: no PKCE login, no copy-code login, no loopback callback listener, no token refresh.
 */
import { describe, expect, it, vi } from "vitest";
import * as loaderModule from "../src/auth/oauth/load.ts";
import { registerBunOAuthFlows } from "../src/bun-oauth.ts";
import * as oauthEntry from "../src/oauth.ts";
import { builtinProviders } from "../src/providers/all.ts";

const registered = vi.hoisted(() => ({ loaders: undefined as Record<string, unknown> | undefined }));

vi.mock("../src/auth/oauth/load.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/auth/oauth/load.ts")>()),
	registerBundledOAuthFlowLoaders: (loaders: Record<string, unknown>) => {
		registered.loaders = loaders;
	},
}));

describe("senpi#4436 the bundled OAuth loaders expose no anthropic flow", () => {
	it("registers no anthropic loader in the standalone binary", () => {
		registerBunOAuthFlows();
		expect(registered.loaders).toBeDefined();
		expect(Object.keys(registered.loaders ?? {})).not.toContain("anthropic");
		expect(Object.keys(registered.loaders ?? {})).toContain("chatgptSubscription");
	});

	it("exports no anthropic loader from the loader module or the oauth entry point", () => {
		const anthropicExports = (module: object) => Object.keys(module).filter((name) => /anthropic/i.test(name));
		expect(anthropicExports(loaderModule)).toEqual([]);
		expect(anthropicExports(oauthEntry)).toEqual([]);
		expect(Object.keys(oauthEntry)).toContain("registerBundledOAuthFlowLoaders");
	});

	// Contract: no builtin Anthropic provider offers an OAuth login, so nothing can start an Anthropic PKCE/copy-code
	// login or bind its callback port; the OAuth logins other providers declare are unaffected.
	it("registers no OAuth login on any builtin Anthropic provider", () => {
		const providers = builtinProviders();
		const anthropicWithOAuth = providers
			.filter((provider) => /anthropic/i.test(provider.id) && provider.auth.oauth !== undefined)
			.map((provider) => provider.id);
		expect(anthropicWithOAuth).toEqual([]);
		expect(providers.find((provider) => provider.id === "anthropic")?.auth.apiKey).toBeDefined();
		expect(providers.find((provider) => provider.id === "chatgpt-subscription")?.auth.oauth).toBeDefined();
	});
});
