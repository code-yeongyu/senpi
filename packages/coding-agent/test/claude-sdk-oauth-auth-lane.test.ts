import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type CredentialStore,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { subscribeProviderAccountEvents } from "../src/core/extensions/builtin/claude-sdk-oauth/account-events.ts";
import {
	type AccountSlot,
	addAccount,
	type ClaudeSdkOauthCredential,
	emptyCredential,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SDKUserMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	closeSession,
	getSession,
	isCurrentGeneration,
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
const providerId = "claude-sdk-oauth";
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];
const residentSessionIds = new Set<string>();

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-claude-sdk-oauth-auth-lane-"));
	temporaryDirectories.push(directory);
	return directory;
}

function queryCapturing(captured: Options[]): SdkQuery {
	return (input) => {
		if (!input.options) throw new Error("SDK query options are required");
		captured.push(input.options);
		const handle: SdkQueryHandle = {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield {
					type: "result",
					subtype: "success",
					result: "ok",
				} as SDKMessage;
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
		ANTHROPIC_BASE_URL: "https://gateway.invalid",
		CLAUDE_CODE_OAUTH_TOKEN: "parent-oauth-token",
		CLAUDE_CODE_USE_BEDROCK: "1",
		CLAUDE_CODE_USE_VERTEX: "1",
		SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE: "untrusted",
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
	for (const sessionId of residentSessionIds) closeSession(sessionId, "test_cleanup");
	residentSessionIds.clear();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

type CloseTrackedQuery = SdkQueryHandle & { closes: number };

function finiteAttempt(outcome: "success" | "failure" | "visible-failure"): CloseTrackedQuery {
	const query: CloseTrackedQuery = {
		closes: 0,
		async *[Symbol.asyncIterator]() {
			if (outcome === "visible-failure") {
				yield {
					type: "stream_event",
					event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
				} as SDKMessage;
				yield {
					type: "stream_event",
					event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
				} as SDKMessage;
			}
			if (outcome !== "success") {
				yield {
					type: "result",
					subtype: "error_during_execution",
					errors: ["rate_limit"],
				} as unknown as SDKMessage;
				return;
			}
			yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
		},
		async interrupt() {},
		close() {
			query.closes++;
		},
	};
	return query;
}

class FailoverResidentQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	closes = 0;
	private readonly outcome: "success" | "failure" | "visible-failure";
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(prompt: AsyncIterable<SDKUserMessage>, outcome: "success" | "failure" | "visible-failure") {
		this.outcome = outcome;
		void this.consume(prompt);
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	async interrupt(): Promise<void> {}

	close(): void {
		this.closes++;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	private emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
		for await (const message of prompt) {
			const uuid = message.uuid ?? "submitted";
			this.emit({ ...message, uuid, isReplay: true } as SDKMessage);
			if (this.outcome === "visible-failure") {
				this.emit({
					type: "stream_event",
					event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
					uuid: "stream-start",
					session_id: message.session_id,
				} as unknown as SDKMessage);
				this.emit({
					type: "stream_event",
					event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
					uuid: "stream-delta",
					session_id: message.session_id,
				} as unknown as SDKMessage);
			}
			if (this.outcome !== "success") {
				this.emit({
					type: "result",
					subtype: "error_during_execution",
					errors: ["rate_limit"],
					user_message_uuid: uuid,
					uuid: "failed-result",
					session_id: message.session_id,
				} as unknown as SDKMessage);
				continue;
			}
			this.emit({
				type: "assistant",
				message: { id: "assistant", type: "message", role: "assistant", content: [] },
				parent_tool_use_id: null,
				uuid: "assistant-success",
				session_id: message.session_id,
			} as unknown as SDKMessage);
			this.emit({
				type: "result",
				subtype: "success",
				result: "ok",
				user_message_uuid: uuid,
				uuid: "success-result",
				session_id: message.session_id,
			} as unknown as SDKMessage);
		}
	}
}

describe("Claude SDK OAuth auth lanes", () => {
	it("injects an OAuth slot and strips higher-precedence API-key sources", async () => {
		const store = await storeWith(slot("default", "slot-access"));
		const captured: Options[] = [];
		configureAuth(store, managedEnvironment(), undefined, "oauth-slots");
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeSdkOauth(model, context).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.env).toMatchObject({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "slot-access" });
		expect(captured[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(captured[0]?.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
		expect(captured[0]?.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
		expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("slot-access");
		expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
	});

	it("preserves the parent environment minus SENPI_* variables in ambient mode", async () => {
		const captured: Options[] = [];
		const { CLAUDE_CODE_OAUTH_TOKEN: _oauthToken, ...ambientEnvironment } = managedEnvironment();
		configureAuth(new InMemoryCredentialStore(), ambientEnvironment);
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeSdkOauth(model, context).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.env).toBeDefined();
		expect(captured[0]?.env?.PATH).toBe("/usr/bin");
		expect(captured[0]?.env?.ANTHROPIC_API_KEY).toBe("parent-api-key");
		expect(captured[0]?.env).not.toHaveProperty("SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE");
		expect(captured[0]?.env).not.toHaveProperty("SENPI_SEED");
	});

	it("refreshes an expired slot before spawning the SDK query", async () => {
		const store = await storeWith(slot("default", "stale-access", Date.now() - 1));
		const captured: Options[] = [];
		let refreshes = 0;
		let receivedSignal: AbortSignal | undefined;
		const controller = new AbortController();
		configureAuth(store, managedEnvironment(), undefined, "oauth-slots");
		overrideAuthLaneBoundary({
			refresher: async (_refresh, signal) => {
				refreshes++;
				receivedSignal = signal;
				return { access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 60 * 60_000 };
			},
		});
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeSdkOauth(model, context, { signal: controller.signal }).result();

		expect(refreshes).toBe(1);
		expect(receivedSignal).toBe(controller.signal);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-access");
		const credential = (await store.read(providerId)) as ClaudeSdkOauthCredential;
		expect(credential.accounts?.[0]).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh" });
	});

	it("writes a private Claude config directory with the CLI OAuth schema", async () => {
		const agentDir = temporaryDirectory();
		const store = await storeWith(slot("work", "config-access", Date.now() + 60 * 60_000));
		await store.modify(providerId, async (current) =>
			current?.type === "oauth" ? { ...current, pinned: "work" } : current,
		);
		const captured: Options[] = [];
		configureAuth(store, managedEnvironment(), agentDir);
		overrideSdkBoundary({ query: queryCapturing(captured) });

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ claudeSdkOauthProvider: { tokenInjection: "config-dir" } }),
		);

		await streamClaudeSdkOauth(model, context).result();

		const configDir = join(agentDir, "claude-sdk-oauth-accounts", "work");
		expect(captured[0]?.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
		expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
		expect(statSync(configDir).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8"))).toEqual({
			claudeAiOauth: {
				accessToken: "config-access",
				refreshToken: "work-refresh",
				expiresAt: expect.any(Number),
				scopes: expect.arrayContaining(["user:inference", "user:sessions:claude_code"]),
			},
		});
	});

	for (const lane of ["oauth-slots", "config-dir", "ambient"] as const) {
		it(`scrubs every SENPI_* variable on the ${lane} auth lane while preserving non-SENPI inheritance`, async () => {
			const store =
				lane === "ambient" ? new InMemoryCredentialStore() : await storeWith(slot("default", "slot-access"));
			const captured: Options[] = [];
			const { CLAUDE_CODE_OAUTH_TOKEN: _oauthToken, ...ambientEnvironment } = managedEnvironment();
			configureAuth(store, ambientEnvironment, undefined, lane === "ambient" ? undefined : lane);
			overrideSdkBoundary({ query: queryCapturing(captured) });

			await streamClaudeSdkOauth(model, context).result();

			expect(captured).toHaveLength(1);
			const env = captured[0]?.env ?? {};
			for (const key of Object.keys(env)) {
				expect(key.startsWith("SENPI_")).toBe(false);
			}
			expect(env).not.toHaveProperty("SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE");
			expect(env).not.toHaveProperty("SENPI_SEED");
			expect(env.PATH).toBe("/usr/bin");
		});
	}

	it("transfers resident-query ownership on failover and fences the discarded generation", async () => {
		const store = await storeWith(slot("A", "access-a"), slot("B", "access-b"));
		configureAuth(store, managedEnvironment(), undefined, "oauth-slots");
		await store.modify(providerId, async (current) =>
			current?.type === "oauth" ? { ...current, pinned: "A" } : current,
		);
		const queries: CloseTrackedQuery[] = [];
		overrideSdkBoundary({
			query: ({ prompt, options }) => {
				const outcome = options?.env?.CLAUDE_CODE_OAUTH_TOKEN === "access-a" ? "failure" : "success";
				const query =
					options?.extraArgs?.["replay-user-messages"] === "" && typeof prompt !== "string"
						? new FailoverResidentQuery(prompt, outcome)
						: finiteAttempt(outcome);
				queries.push(query);
				return query;
			},
		});
		const sessionId = "resident-failover";
		residentSessionIds.add(sessionId);

		const result = await streamClaudeSdkOauth(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ sessionId, streamKind: "main" },
		).result();

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(queries).toHaveLength(2);
		expect(queries[0]?.closes).toBe(1);
		expect(queries[1]?.closes).toBe(0);
		expect(isCurrentGeneration(sessionId, 1)).toBe(false);
		expect(getSession(sessionId)).toMatchObject({ generation: 2 });
		expect(getSession(sessionId)?.accountName).not.toBe("A");
	});

	it("discards a failed resident query without retrying after a visible delta", async () => {
		const store = await storeWith(slot("A", "access-a"), slot("B", "access-b"));
		configureAuth(store, managedEnvironment(), undefined, "oauth-slots");
		await store.modify(providerId, async (current) =>
			current?.type === "oauth" ? { ...current, pinned: "A" } : current,
		);
		const queries: CloseTrackedQuery[] = [];
		overrideSdkBoundary({
			query: ({ prompt, options }) => {
				const query =
					options?.extraArgs?.["replay-user-messages"] === "" && typeof prompt !== "string"
						? new FailoverResidentQuery(prompt, "visible-failure")
						: finiteAttempt("visible-failure");
				queries.push(query);
				return query;
			},
		});
		const sessionId = "resident-visible-failure";
		residentSessionIds.add(sessionId);

		const result = await streamClaudeSdkOauth(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ sessionId, streamKind: "main" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "partial" })]);
		expect(queries).toHaveLength(1);
		expect(queries[0]?.closes).toBe(1);
		expect(getSession(sessionId)).toBeUndefined();
	});

	it("fails over from an invalid stale slot before the first delta without surfacing an OAuth error", async () => {
		const store = await storeWith(
			slot("A", "expired-access", Date.now() - 1),
			slot("B", "valid-access", Date.now() + 60 * 60_000),
		);
		const captured: Options[] = [];
		const { CLAUDE_CODE_OAUTH_TOKEN: _oauthToken, ...environment } = managedEnvironment();
		configureAuth(store, environment, undefined, "oauth-slots");
		await store.modify(providerId, async (current) =>
			current?.type === "oauth" ? { ...current, pinned: "A" } : current,
		);
		overrideAuthLaneBoundary({ refresher: async () => Promise.reject(new Error("invalid refresh")) });
		overrideSdkBoundary({ query: queryCapturing(captured) });
		const accountEvents: Array<Record<string, unknown>> = [];
		const unsubscribe = subscribeProviderAccountEvents((event) => accountEvents.push(event));

		try {
			const result = await streamClaudeSdkOauth(model, context).result();

			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			expect(captured.map((options) => options.env?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["valid-access"]);
			const credential = (await store.read(providerId)) as ClaudeSdkOauthCredential;
			expect(credential.accounts?.find((account) => account.name === "A")).toMatchObject({
				blockReason: "auth_error",
			});
			expect(accountEvents).toEqual([
				{ type: "accounts_changed", provider: providerId },
				{ type: "failover", provider: providerId, from: "A", to: "B", reason: "auth_error" },
			]);
		} finally {
			unsubscribe();
		}
	});
});
