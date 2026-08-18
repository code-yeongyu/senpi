import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type CredentialStore,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AccountSlot,
	addAccount,
	type ClaudeSdkOauthCredential,
	emptyCredential,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const model: Model<Api> = {
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
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
const providerId = "claude-sdk-oauth";
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-6784-"));
	temporaryDirectories.push(directory);
	return directory;
}

function queryCapturing(captured: Options[]): SdkQuery {
	return (input) => {
		if (!input.options) throw new Error("SDK query options are required");
		captured.push(input.options);
		const handle: SdkQueryHandle = {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
		return handle;
	};
}

async function storeWith(...credentials: AccountSlot[]): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () =>
		credentials.reduce<ClaudeSdkOauthCredential>(
			(credential, slot) => addAccount(credential, slot),
			emptyCredential(),
		),
	);
	return store;
}

function slot(name: string, access: string, expires = Date.now() + 60 * 60_000) {
	return { name, access, refresh: `${name}-refresh`, expires, source: "login" as const };
}

function managedEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin",
		ANTHROPIC_API_KEY: "parent-api-key",
		ANTHROPIC_AUTH_TOKEN: "parent-auth-token",
		CLAUDE_CODE_OAUTH_TOKEN: "parent-oauth-token",
		SENPI_SEED: "parent-seed",
	};
}

function configureAuth(
	store: CredentialStore,
	environment: NodeJS.ProcessEnv,
	agentDir = temporaryDirectory(),
	tokenInjection?: string,
): void {
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	if (tokenInjection) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ claudeSdkOauthProvider: { tokenInjection } }));
	}
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => environment,
		getAgentDir: () => agentDir,
	});
}

afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("issue #6784: stored Claude SDK OAuth account is used by default", () => {
	it("injects the stored OAuth token into the subprocess without an explicit tokenInjection setting", async () => {
		const store = await storeWith(slot("default", "slot-access"));
		const captured: Options[] = [];
		const { CLAUDE_CODE_OAUTH_TOKEN: _oauthToken, ...ambientEnvironment } = managedEnvironment();
		configureAuth(store, ambientEnvironment);
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeSdkOauth(model, context).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("slot-access");
		expect(captured[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(captured[0]?.env).not.toHaveProperty("SENPI_SEED");
	});

	it("falls back to ambient when no accounts are stored and no setting is configured", async () => {
		const captured: Options[] = [];
		const { CLAUDE_CODE_OAUTH_TOKEN: _oauthToken, ...ambientEnvironment } = managedEnvironment();
		configureAuth(new InMemoryCredentialStore(), ambientEnvironment);
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeSdkOauth(model, context).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(captured[0]?.env?.ANTHROPIC_API_KEY).toBe("parent-api-key");
	});

	it("respects an explicit ambient setting even when accounts are stored", async () => {
		const store = await storeWith(slot("default", "slot-access"));
		const captured: Options[] = [];
		const { CLAUDE_CODE_OAUTH_TOKEN: _oauthToken, ...ambientEnvironment } = managedEnvironment();
		configureAuth(store, ambientEnvironment, undefined, "ambient");
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeSdkOauth(model, context).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(captured[0]?.env?.ANTHROPIC_API_KEY).toBe("parent-api-key");
	});

	it("reports the provider as configured for fallback without probing ambient auth", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAmbientAuthStatus,
		} as Parameters<typeof createOAuthConfig>[0] & {
			readAmbientAuthStatus: () => Promise<boolean>;
		}) as ReturnType<typeof createOAuthConfig> & { check?: unknown };
		const credential = {
			...emptyCredential(),
			accounts: [account("default", "slot-access")],
		};
		const ctx = { env: async () => undefined, fileExists: async () => false };

		expect(
			await (config.check as (input: { ctx: typeof ctx; credential?: typeof credential }) => Promise<unknown>)({
				ctx,
				credential,
			}),
		).toEqual({ type: "oauth", source: "Claude SDK OAuth" });
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});
});

function account(name: string, access: string) {
	return { name, refresh: "refresh", access, expires: Date.now() + 60_000, source: "login" as const };
}
