import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderAuth } from "../../ai/src/auth/resolve.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import type { Options, SDKMessage, SdkQuery } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { authContext, composedProvider, credentialStore } from "./support/claude-sdk-oauth-provider.ts";

function queryCapturing(captured: Options[]): SdkQuery {
	return ({ options }) => {
		if (!options) throw new Error("SDK query options are required");
		captured.push(options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
}

afterEach(resetAuthLaneBoundary);

describe("claude-sdk-oauth cross-slot empty masking", () => {
	it("does not import or promote another host token slot during replay", async () => {
		const hostEnvironment = {
			PATH: "/usr/bin",
			CLAUDE_CODE_OAUTH_TOKEN: "host-primary",
			CLAUDE_CODE_OAUTH_TOKEN_2: "host-secondary",
		};
		const requestEnvironment = { CLAUDE_CODE_OAUTH_TOKEN: "" };
		const provider = composedProvider(async () => true, {}, { enabled: true });
		const first = await resolveProviderAuth(provider, credentialStore(), authContext(hostEnvironment), {
			env: requestEnvironment,
		});
		if (!first?.auth.apiKey) throw new Error("expected ambient auth");
		const replay = await resolveProviderAuth(provider, credentialStore(), authContext(hostEnvironment), {
			apiKey: first.auth.apiKey,
			env: first.env,
		});
		const captured: Options[] = [];
		overrideAuthLaneBoundary({
			createStore: () => new InMemoryCredentialStore(),
			env: () => hostEnvironment,
		});
		for await (const _message of queryWithAuthLane({
			prompt: "",
			query: queryCapturing(captured),
			providerSettings: {},
			env: replay?.env,
			buildOptions: () => ({}),
		})) {
			// Drain the synthetic query.
		}

		expect(first.env).toEqual(requestEnvironment);
		expect(replay?.env).toEqual(requestEnvironment);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
		expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN_2");
	});
});
