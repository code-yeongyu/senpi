import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Context, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
	SdkQueryHandle,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { overrideSdkBoundary, resetSdkBoundary } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	closeSession,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};
const context: Context = { messages: [] };
const residentSessionId = "resident-request-env";

function queryCapturing(captured: Options[]): SdkQuery {
	return ({ options }) => {
		if (!options) throw new Error("SDK query options are required");
		captured.push(options);
		const query: SdkQueryHandle = {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
		return query;
	};
}

async function captureRequestEnvironment(
	hostEnvironment: NodeJS.ProcessEnv,
	requestEnvironment: Record<string, string>,
	options: { pinnedAccount?: string; tokenInjection?: "ambient" | "config-dir" | "oauth-slots" } = {},
): Promise<NodeJS.ProcessEnv | undefined> {
	const captured: Options[] = [];
	overrideAuthLaneBoundary({
		createStore: () => new InMemoryCredentialStore(),
		env: () => hostEnvironment,
	});
	for await (const _message of queryWithAuthLane({
		prompt: "",
		query: queryCapturing(captured),
		providerSettings: options.tokenInjection ? { tokenInjection: options.tokenInjection } : {},
		env: requestEnvironment,
		pinnedAccount: options.pinnedAccount,
		buildOptions: () => ({}),
	})) {
		// Drain the synthetic query.
	}
	return captured[0]?.env;
}

afterEach(() => {
	closeSession(residentSessionId, "test_cleanup");
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
});

describe("claude-sdk-oauth request environment", () => {
	it("forwards request OAuth tokens without subprocess-control variables", async () => {
		const environment = await captureRequestEnvironment(
			{ PATH: "/usr/bin" },
			{
				CLAUDE_CODE_OAUTH_TOKEN: "request-token",
				CLAUDE_CONFIG_DIR: "/tmp/request-config",
				NODE_OPTIONS: "--require=/tmp/request-hook.js",
				PATH: "/tmp/request-bin",
			},
			{ tokenInjection: "ambient" },
		);

		expect(environment?.CLAUDE_CODE_OAUTH_TOKEN).toBe("request-token");
		expect(environment?.PATH).toBe("/usr/bin");
		expect(environment).not.toHaveProperty("CLAUDE_CONFIG_DIR");
		expect(environment).not.toHaveProperty("NODE_OPTIONS");
	});

	it("replaces the host OAuth token namespace when request tokens are present", async () => {
		const environment = await captureRequestEnvironment(
			{
				PATH: "/usr/bin",
				CLAUDE_CODE_OAUTH_TOKEN_2: "host-token-2",
			},
			{ CLAUDE_CODE_OAUTH_TOKEN: "request-token" },
			{ pinnedAccount: "env-2", tokenInjection: "oauth-slots" },
		);

		expect(environment?.CLAUDE_CODE_OAUTH_TOKEN).toBe("request-token");
	});

	it("forwards request authentication through the resident session lane", async () => {
		const captured: Options[] = [];
		overrideAuthLaneBoundary({
			createStore: () => new InMemoryCredentialStore(),
			env: () => ({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "host-token" }),
		});
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeSdkOauth(model, context, {
			env: { CLAUDE_CODE_OAUTH_TOKEN: "request-token" },
			sessionId: residentSessionId,
			streamKind: "main",
		}).result();

		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("request-token");
	});

	it("does not persist request tokens in config-dir mode", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-request-auth-"));
		const captured: Options[] = [];
		overrideAuthLaneBoundary({
			createStore: () => new InMemoryCredentialStore(),
			env: () => ({ PATH: "/usr/bin" }),
			getAgentDir: () => agentDir,
		});
		try {
			for await (const _message of queryWithAuthLane({
				prompt: "",
				query: queryCapturing(captured),
				providerSettings: { tokenInjection: "config-dir" },
				env: { CLAUDE_CODE_OAUTH_TOKEN: "request-token" },
				buildOptions: () => ({}),
			})) {
				// Drain the synthetic query.
			}

			expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("request-token");
			expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
			expect(existsSync(join(agentDir, "claude-sdk-oauth-accounts"))).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
