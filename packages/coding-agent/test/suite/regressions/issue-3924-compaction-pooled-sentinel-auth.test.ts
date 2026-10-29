import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { rendezvousOrder } from "@earendil-works/pi-ai/auth/pool/select";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import { sha256SlotHasher } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository, type CredentialSlotState } from "../../../src/core/credential-pool/state-store.ts";
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
const SESSION_ID = "session-3924";
const ACCOUNTS = ["default", "work"] as const;
type AccountName = (typeof ACCOUNTS)[number];
type Health = Pick<CredentialSlotState, "blockedUntil" | "blockReason">;

function pooledSentinel(pinned: AccountName | undefined = "work"): PooledCredential {
	const expires = Date.now() + 3_600_000;
	return {
		type: "oauth",
		access: SENTINEL,
		refresh: SENTINEL,
		expires: 0,
		...(pinned === undefined ? {} : { pinned }),
		accounts: ACCOUNTS.map((name) => ({
			name,
			access: `access-${name}`,
			refresh: `refresh-${name}`,
			expires,
			source: "login" as const,
		})),
	};
}

/** Health the pool recorded for an account, bound to its current material like a real block. */
async function seedHealth(name: AccountName, health: Health): Promise<void> {
	const repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	const credentialRevision = await repository.storedCredentialRevision(PROVIDER, name, {
		access: `access-${name}`,
		refresh: `refresh-${name}`,
	});
	await repository.mutateSlotState(PROVIDER, "stored", name, () => ({ ...health, credentialRevision }));
}

/** The account the rotation stream's affinity order starts this session on when nothing is pinned. */
function affinityWinner(): AccountName {
	const [winner] = rendezvousOrder(
		SESSION_ID,
		ACCOUNTS.map((name) => ({ name })),
		sha256SlotHasher,
	);
	if (winner === undefined) throw new Error("empty affinity order");
	return winner.name;
}

const disabled: Health = { blockReason: "account_disabled" };
const rateLimitedFor = (ms: number): Health => ({ blockReason: "rate_limit", blockedUntil: Date.now() + ms });

type PickRow = {
	name: string;
	pinned: AccountName | undefined;
	health: Partial<Record<AccountName, () => Health>>;
	expected: () => { ok: true; apiKey: string } | { ok: false; error: RegExp };
};

// Each row is the stream's first pick for the session (senpi#3924 review): the auxiliary request
// must authenticate as that account, or refuse exactly when the stream refuses.
const PICK_ROWS: PickRow[] = [
	{ name: "the pinned account", pinned: "work", health: {}, expected: () => ({ ok: true, apiKey: "access-work" }) },
	{
		name: "the session's affinity account when nothing is pinned",
		pinned: undefined,
		health: {},
		expected: () => ({ ok: true, apiKey: `access-${affinityWinner()}` }),
	},
	{
		name: "the next account when the pinned one is blocked",
		pinned: "work",
		health: { work: () => disabled },
		expected: () => ({ ok: true, apiKey: "access-default" }),
	},
	{
		name: "the rate-limited account due back first when every account is blocked",
		pinned: "default",
		health: { default: () => rateLimitedFor(3_600_000), work: () => rateLimitedFor(60_000) },
		expected: () => ({ ok: true, apiKey: "access-work" }),
	},
	{
		name: "the stream's refusal when every account is disabled",
		pinned: "work",
		health: { default: () => disabled, work: () => disabled },
		expected: () => ({ ok: false, error: /No credential slots available/ }),
	},
];

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

async function pooledRegistry(
	pinned: AccountName | undefined = "work",
): Promise<{ registry: ModelRegistry; model: Model<Api> }> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [PROVIDER]: pooledSentinel(pinned) }),
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
	it.each(PICK_ROWS)("resolves $name and never sends the sentinel to the token endpoint", async (row) => {
		for (const name of ACCOUNTS) {
			const health = row.health[name];
			if (health) await seedHealth(name, health());
		}
		const { registry, model } = await pooledRegistry(row.pinned);

		const auth = await registry.getApiKeyAndHeaders(model, { sessionId: SESSION_ID });

		const expected = row.expected();
		if (expected.ok) expect(auth).toMatchObject(expected);
		else expect(auth).toEqual({ ok: false, error: expect.stringMatching(expected.error) });
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
