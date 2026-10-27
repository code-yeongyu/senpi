import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry, type ResolvedRequestAuth } from "../../../src/core/model-registry.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

/**
 * senpi#3924: a pooled `chatgpt-subscription` entry whose flat fields are the
 * provider-managed sentinel (`expires: 0`) with the real tokens in `accounts[]`.
 * Compaction resolved auth without a slot, so the resolver "refreshed" the
 * sentinel at the token endpoint and every compaction failed with a 401 while
 * the session's own turns, leased on the pinned slot, kept working.
 */

const PROVIDER = "chatgpt-subscription";
const SENTINEL = `${PROVIDER}-managed`;
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

function pooledSentinel(): PooledCredential {
	const expires = Date.now() + 3_600_000;
	return {
		type: "oauth",
		access: SENTINEL,
		refresh: SENTINEL,
		expires: 0,
		pinned: "work",
		accounts: [
			{ name: "default", access: "access-default", refresh: "refresh-default", expires, source: "login" },
			{ name: "work", access: "access-work", refresh: "refresh-work", expires, source: "login" },
		],
	};
}

let dir: string;
let tokenEndpointCalls: number;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-3924-"));
	tokenEndpointCalls = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === TOKEN_ENDPOINT) tokenEndpointCalls += 1;
		return new Response(JSON.stringify({ error: { code: "token_expired" } }), { status: 401 });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

async function pooledRegistry(): Promise<{ registry: ModelRegistry; model: Model<Api> }> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [PROVIDER]: pooledSentinel() }),
		modelsPath: null,
		agentDir: dir,
		allowModelNetwork: false,
	});
	await runtime.refresh({ allowNetwork: false, providers: [PROVIDER] });
	const registry = new ModelRegistry(runtime);
	const model = registry.getAll().find((candidate) => candidate.provider === PROVIDER);
	if (!model) throw new Error(`no ${PROVIDER} model in the offline catalog`);
	return { registry, model };
}

describe("issue #3924: auxiliary auth on a pooled provider with a managed sentinel", () => {
	it("resolves the session's pinned account and never sends the sentinel to the token endpoint", async () => {
		const { registry, model } = await pooledRegistry();

		const auth = await registry.getApiKeyAndHeaders(model, { sessionId: "session-3924" });

		expect(auth).toMatchObject({ ok: true, apiKey: "access-work" });
		expect(tokenEndpointCalls).toBe(0);
	});

	it("a session-less resolution refuses the sentinel instead of exchanging it", async () => {
		const { registry, model } = await pooledRegistry();

		const auth = await registry.getApiKeyAndHeaders(model);

		expect(auth.ok).toBe(false);
		expect(tokenEndpointCalls).toBe(0);
	});

	it("compaction summarizes with the session's account", async () => {
		const { registry, model } = await pooledRegistry();
		const sessionManager = SessionManager.inMemory();
		const controller = new AbortController();
		const resolved: ResolvedRequestAuth[] = [];
		// Stop right after credential resolution: the outcome under test is which
		// account compaction authenticates as, not the summary request itself.
		const modelRegistry = Object.create(registry) as ModelRegistry;
		modelRegistry.getApiKeyAndHeaders = async (...args: Parameters<ModelRegistry["getApiKeyAndHeaders"]>) => {
			const auth = await registry.getApiKeyAndHeaders(...args);
			resolved.push(auth);
			controller.abort();
			return auth;
		};
		const context = {
			model,
			sessionManager,
			modelRegistry,
			getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: model.contextWindow }),
			getMessageRevision: () => 1,
			applyCompaction: vi.fn(),
		} as unknown as SpeculativeCompactionContext;
		const snapshot = {
			generation: 1,
			expectedRevision: 1,
			model,
			contextWindow: model.contextWindow,
			preparation: {
				firstKeptEntryId: "keep",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 0,
				fileOps: createFileOps(),
				settings: { ...DEFAULT_COMPACTION_SETTINGS },
			},
			promptVariant: "default" as const,
			origin: "blocking" as const,
			systemPrompt: "",
		} as unknown as SpeculativeCompactionSnapshot;

		await expect(runExtensionCompaction(context, snapshot, controller.signal)).resolves.toBeUndefined();

		expect(resolved).toEqual([expect.objectContaining({ ok: true, apiKey: "access-work" })]);
		expect(tokenEndpointCalls).toBe(0);
	});
});
