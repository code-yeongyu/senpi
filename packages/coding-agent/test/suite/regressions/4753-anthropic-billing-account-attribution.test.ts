// Desktop#4753: billing failures must identify the account actually attempted, without credential material.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";

const now = 1_800_000_000_000;
const agentDir = mkdtempSync(join(tmpdir(), "senpi-4753-billing-"));
const first: AccountSlot = cliSlot("primary", { displayName: "private@example.invalid" });
const second: AccountSlot = cliSlot("secondary", { displayName: "private@example.invalid" });
const refusal = "API Error: 400 You're out of extra usage.";

async function configure(accounts: AccountSlot[] = [], environment: NodeJS.ProcessEnv = {}) {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () => ({
		...emptyCredential(),
		accounts,
		pinned: accounts[0]?.name,
	}));
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ ...cliLaneEnv(), ...environment }),
		getAgentDir: () => agentDir,
		now: () => now,
	});
	return store;
}

async function failRequest(input: {
	readonly ambient?: boolean;
	readonly accountFallback?: boolean;
	readonly failure?: string;
	readonly preferredAccount?: string;
	readonly eventFailure?: boolean;
	readonly pinSource?: "cli" | "settings" | "stored";
}) {
	const query: SdkQuery = () => ({
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
			if (input.eventFailure) {
				yield {
					type: "result",
					subtype: "error_during_execution",
					uuid: "00000000-0000-4000-8000-000000000001",
					session_id: "synthetic-sdk-session",
					duration_ms: 0,
					duration_api_ms: 0,
					is_error: true,
					num_turns: 1,
					stop_reason: null,
					total_cost_usd: 0,
					usage: {
						input_tokens: 7,
						output_tokens: 3,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						fallback_credit: null,
						inference_geo: "us",
						iterations: [],
						output_tokens_details: { thinking_tokens: 0 },
						speed: "standard",
						server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
						service_tier: "standard",
						cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
					},
					modelUsage: {},
					permission_denials: [],
					errors: [input.failure ?? refusal],
				};
			} else {
				throw new Error(input.failure ?? refusal);
			}
		},
		async interrupt() {},
		close() {},
	});
	try {
		for await (const _message of queryWithAuthLane({
			prompt: "synthetic prompt",
			query,
			buildOptions: () => ({}),
			providerSettings: {
				tokenInjection: input.ambient ? "ambient" : "oauth-slots",
				accountFallback: input.accountFallback ?? false,
				...(input.pinSource === "settings" ? { pinnedAccount: first.name } : {}),
			},
			...(input.pinSource === "cli" ? { pinnedAccount: first.name } : {}),
			preferredAccount: input.preferredAccount,
			sessionId: "synthetic-session",
		})) {
			// The ambient lane leaves failed result handling to the public stream boundary.
		}
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return { error, shown: withAuthGuidance(error, error.message) };
	}
	throw new Error("Expected a rejected request");
}

afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

afterEach(() => {
	closeSession("synthetic-public-main", "test_cleanup");
	resetAuthLaneBoundary();
	resetSdkBoundary();
	resetContinuityObservabilityBoundary();
});

describe("billing account attribution", () => {
	it.each(["login", "env", "ambient"] as const)(
		"names the selected %s source without private fields",
		async (source) => {
			const account = first;
			await configure(source === "env" || source === "ambient" ? [] : [account], {
				CLAUDE_CODE_OAUTH_TOKEN: source === "env" ? "synthetic-env-token" : undefined,
			});
			const { shown } = await failRequest({ ambient: source === "ambient" });
			expect(shown).toContain(source === "env" ? "env" : source === "ambient" ? "ambient" : account.name);
			expect(shown).toContain(source);
			if (source !== "ambient") expect(shown).toContain("/claude-account pin");
			expect(shown).toContain("claude.ai/settings/usage");
			expect(shown).not.toContain(first.displayName);
			expect(shown).not.toContain("synthetic-env-token");
		},
	);

	it("attributes the terminal billing refusal to the last fallback account", async () => {
		await configure([first, second]);
		const { shown } = await failRequest({ accountFallback: true, failure: "billing_error" });
		expect(shown).toContain(second.name);
		expect(shown).toContain(second.source);
		expect(shown).not.toContain(first.name);
	});

	it("keeps failed SDK result attribution through the failover wrapper", async () => {
		await configure([first]);
		const { shown } = await failRequest({ eventFailure: true, failure: "billing_error" });
		expect(shown).toContain(first.name);
		expect(shown).toContain(first.source);
	});

	it("logs only the selected store and account provenance when an attempt opens", async () => {
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		overrideContinuityObservabilityBoundary({ log: (event, data) => events.push({ event, data }) });
		await configure([first]);
		await failRequest({});
		expect(events).toContainEqual({
			event: "claude_sdk_oauth_session_auth",
			data: {
				sessionId: "synthetic-session",
				agentDir: expect.stringMatching(/^dir:[0-9a-f]{8}$/),
				agentDirSource: expect.any(String),
				agentDirRule: expect.stringMatching(/^(environment|home-default|project-local)$/),
				seat: expect.stringMatching(/^[0-9a-f]{8}$/),
				accountSource: first.source,
			},
		});
		expect(JSON.stringify(events)).not.toContain(first.displayName);
		expect(JSON.stringify(events)).not.toContain(first.name);
	});

	it("does not attach billing instructions to an unrelated refusal", async () => {
		await configure([first]);
		const { shown } = await failRequest({ failure: "model_not_found" });
		expect(shown).not.toContain(first.name);
	});
	it.each([
		["cli", "--claude-account"],
		["settings", "anthropicSubscriptionProvider.pinnedAccount"],
		["stored", "/claude-account pin"],
	] as const)("names the effective %s pin action", async (pinSource, action) => {
		await configure([first]);
		const { shown } = await failRequest({ pinSource });
		expect(shown).toContain(action);
		if (pinSource !== "stored") expect(shown).not.toContain("/claude-account pin");
	});

	it.each(["main", "auxiliary"] as const)(
		"delivers account attribution in the public %s assistant error",
		async (streamKind) => {
			await configure([first]);
			overrideSdkBoundary({
				query: () => ({
					[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
						return { next: async () => Promise.reject(new Error(refusal)) };
					},
					async interrupt() {},
					close() {},
				}),
			});
			const model: Model<Api> = {
				id: "claude-test",
				name: "Claude",
				api: "claude-sdk-oauth",
				provider: "anthropic-subscription",
				baseUrl: "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			};
			const result = await streamAnthropicSubscription(
				model,
				{ messages: [] },
				{
					cwd: process.cwd(),
					streamKind,
					sessionId: "synthetic-public-main",
				},
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(first.name);
			expect(result.errorMessage).toContain(first.source);
			expect(result.errorMessage).toContain("/claude-account pin");
			expect(result.errorMessage).not.toContain(first.displayName);
		},
	);
});
