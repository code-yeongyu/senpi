import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Context, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const providerId = "claude-sdk-oauth";
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: providerId,
	provider: providerId,
	baseUrl: providerId,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = { messages: [] };

function captureQuery(captured: Options[]): SdkQuery {
	return (input) => {
		if (!input.options) throw new Error("SDK query options are required");
		captured.push(input.options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
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

it("uses stored OAuth slots when token injection is not configured", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-claude-oauth-default-lane-"));
	temporaryDirectories.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;

	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () =>
		addAccount(emptyCredential(), {
			name: "default",
			access: "stored-slot-access",
			refresh: "stored-slot-refresh",
			expires: 4_102_444_800_000,
			source: "login",
		}),
	);

	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({
			PATH: "/usr/bin",
			CLAUDE_CODE_OAUTH_TOKEN: "ambient-access",
		}),
		getAgentDir: () => agentDir,
	});
	const captured: Options[] = [];
	overrideSdkBoundary({ query: captureQuery(captured) });

	await streamClaudeSdkOauth(model, context).result();

	expect(captured).toHaveLength(1);
	expect(captured[0]?.env).toMatchObject({
		PATH: "/usr/bin",
		CLAUDE_CODE_OAUTH_TOKEN: "stored-slot-access",
	});
});

it("preserves ambient credentials when ambient injection is explicit", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-claude-oauth-explicit-ambient-"));
	temporaryDirectories.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ claudeSdkOauthProvider: { tokenInjection: "ambient" } }),
	);

	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () =>
		addAccount(emptyCredential(), {
			name: "default",
			access: "stored-slot-access",
			refresh: "stored-slot-refresh",
			expires: 4_102_444_800_000,
			source: "login",
		}),
	);

	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({
			PATH: "/usr/bin",
			CLAUDE_CODE_OAUTH_TOKEN: "ambient-access",
		}),
		getAgentDir: () => agentDir,
	});
	const captured: Options[] = [];
	overrideSdkBoundary({ query: captureQuery(captured) });

	await streamClaudeSdkOauth(model, context).result();

	expect(captured).toHaveLength(1);
	expect(captured[0]?.env).toMatchObject({
		PATH: "/usr/bin",
		CLAUDE_CODE_OAUTH_TOKEN: "ambient-access",
	});
});
