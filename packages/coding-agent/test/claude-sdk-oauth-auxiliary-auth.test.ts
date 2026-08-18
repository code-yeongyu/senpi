import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { generateSessionTitle } from "../src/core/session-title-generator.ts";
import { authContext, composedProvider } from "./support/claude-sdk-oauth-provider.ts";

function queryCapturing(captured: Options[]): SdkQuery {
	return ({ options }) => {
		if (!options) throw new Error("SDK query options are required");
		captured.push(options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield {
					type: "result",
					subtype: "success",
					result: "<title>Auxiliary Auth Works</title>",
				} as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
}

afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
});

describe("claude-sdk-oauth auxiliary authentication", () => {
	it("keeps request auth idempotent through title generation and SDK spawn", async () => {
		const provider = composedProvider(async () => false);
		const credentials = new InMemoryCredentialStore();
		const hostEnvironment = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "host-token" };
		const requestEnvironment = { CLAUDE_CODE_OAUTH_TOKEN: "request-token" };
		const models = createModels({ credentials, authContext: authContext(hostEnvironment) });
		models.setProvider(provider);
		const captured: Options[] = [];
		overrideAuthLaneBoundary({ createStore: () => credentials, env: () => hostEnvironment });
		overrideSdkBoundary({ query: queryCapturing(captured) });

		const first = await models.getAuth(provider.id, { env: requestEnvironment });
		if (!first?.auth.apiKey) throw new Error("Expected initial ambient auth");
		const replay = await models.getAuth(provider.id, { apiKey: first.auth.apiKey, env: first.env });
		const model = provider.getModels()[0];
		if (!model) throw new Error("Expected registered Claude model");
		const title = await generateSessionTitle({
			firstPrompt: "Fix the ambient authentication boundary",
			model,
			auth: { apiKey: first.auth.apiKey, env: first.env },
			sessionId: "ambient-title-test",
			streamFn: (titleModel, titleContext, titleOptions) =>
				models.streamSimple(titleModel, titleContext, titleOptions),
		});

		expect(replay?.auth.apiKey).toBe(first.auth.apiKey);
		expect(replay?.env).toEqual(requestEnvironment);
		expect(title).toBe("Auxiliary Auth Works");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("request-token");
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("host-token");
	});
});
