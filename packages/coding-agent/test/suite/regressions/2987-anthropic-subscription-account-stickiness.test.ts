// Issue #2987: account stickiness follow-ups — the resident path must prefer the
// live session's (or a restored binding's) account, aborting must cut a transient
// retry wait short, and a non-main request must follow the session's account too.
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AccountSlot,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { rendezvousOrder } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { overrideAuthLaneBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { forgetSessionBlocksFor } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { overrideSdkBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { residentSessionMessages } from "../../../src/core/extensions/builtin/anthropic-subscription/session-stream.ts";
import { loadAnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import { cliAccountOf, cliDirId, cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";
import {
	installScriptedSdk,
	resetScriptedSdk,
	sdkMessage,
	type ScriptedResidentQuery,
	type TurnScript,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";

const PROVIDER = "anthropic-subscription";
const SESSION = "senpi-2987-session";
const now = 1_800_000_000_000;
const pool: AccountSlot[] = [cliSlot("alpha"), cliSlot("bravo")];
// The HRW winner for this session id — the account a turn would pick WITHOUT the
// resident wiring. Every test seeds the session on `other`, so only the wiring
// can make the turn serve on `other` instead of `home`.
const [home, other] = rendezvousOrder(SESSION, pool).map((account) => account.name) as [string, string];

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function firstTurnContext(): Context {
	return {
		systemPrompt: "SYSTEM",
		messages: [{ role: "user", content: "first turn", timestamp: 1 }],
	} as Context;
}

function secondTurnContext(): Context {
	return {
		systemPrompt: "SYSTEM",
		messages: [
			{ role: "user", content: "first turn", timestamp: 1 },
			{ role: "user", content: "next turn", timestamp: 2 },
		],
	} as Context;
}

function settings() {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () =>
		JSON.stringify({ anthropicSubscriptionProvider: { tokenInjection: "oauth-slots" } }),
	);
	storage.withLock("project", () => JSON.stringify({ anthropicSubscriptionProvider: {} }));
	return loadAnthropicSubscriptionProviderSettings(SettingsManager.fromStorage(storage), {});
}

async function configure(): Promise<void> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () => ({ ...emptyCredential(), accounts: pool }));
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => cliLaneEnv(),
		now: () => now,
	});
}

const successScript: TurnScript = (sessionId, userUuid) => [
	sdkMessage({
		type: "result",
		subtype: "success",
		is_error: false,
		user_message_uuid: userUuid,
		session_id: sessionId,
	}),
];

const overloadedScript: TurnScript = (sessionId, userUuid) => [
	sdkMessage({
		type: "result",
		subtype: "error",
		is_error: true,
		result: "overloaded",
		api_error_status: 529,
		user_message_uuid: userUuid,
		session_id: sessionId,
	}),
];

async function collectResidentTurn(
	context: Context,
	options: { signal?: AbortSignal; pinnedAccount?: string } = {},
): Promise<{ messages: SDKMessage[]; observedKinds: string[] }> {
	const observedKinds: string[] = [];
	const messages: SDKMessage[] = [];
	for await (const message of residentSessionMessages({
		model,
		context,
		streamOptions: { sessionId: SESSION, ...(options.signal ? { signal: options.signal } : {}) },
		providerSettings: settings(),
		...(options.pinnedAccount ? { pinnedAccount: options.pinnedAccount } : {}),
		buildOptions: () => ({}),
		customToolNameToSdk: new Map(),
		onResumeFallback: () => {},
		onContinuityDecision: (observation) => {
			observedKinds.push(observation.kind);
		},
	})) {
		messages.push(message);
	}
	return { messages, observedKinds };
}

// Run a first turn pinned to `other` so the resident entry (and its binding) is created on the non-HRW account through the real code path — a hand-seeded entry would carry a fingerprint the turn's own options would not reproduce.
async function bootstrapOnOther(script: TurnScript): Promise<ScriptedResidentQuery[]> {
	const queries = installScriptedSdk(script);
	const first = await collectResidentTurn(firstTurnContext(), { pinnedAccount: other });
	expect(first.messages.map((message) => message.type)).toEqual(["result"]);
	expect(getSession(SESSION)?.accountName).toBe(other);
	return queries;
}

afterEach(() => {
	closeSession(SESSION, "test_cleanup");
	forgetBinding(SESSION);
	for (const name of ["alpha", "bravo"]) forgetSessionBlocksFor(name);
	resetScriptedSdk();
	vi.useRealTimers();
});

describe("senpi#2987 resident account stickiness", () => {
	it("prefers the live session's account on the next turn (item 1a)", async () => {
		await configure();
		const queries = await bootstrapOnOther(successScript);

		const { messages, observedKinds } = await collectResidentTurn(secondTurnContext());

		expect(messages.map((message) => message.type)).toEqual(["result"]);
		expect(observedKinds).toEqual(["delta"]);
		// The live entry is reused: no second subprocess is spawned, and the
		// only query ever created runs on the live session's account, not the
		// HRW winner.
		expect(queries).toHaveLength(1);
		expect(cliAccountOf(queries[0]?.options?.env)).toBe(other);
		expect(cliAccountOf(queries[0]?.options?.env)).not.toBe(home);
		expect(getSession(SESSION)?.accountName).toBe(other);
	});

	it("prefers a restored binding's account after a restart (item 1b)", async () => {
		await configure();
		const queries = await bootstrapOnOther(successScript);
		// Restart: the live entry is gone, only the binding survives.
		closeSession(SESSION, "test_restart");

		const { messages, observedKinds } = await collectResidentTurn(secondTurnContext());

		expect(messages.map((message) => message.type)).toEqual(["result"]);
		// A resume observation is reported with the "fork" label by the
		// observability mapping; the point is the turn resumed, not cold-seeded.
		expect(observedKinds).toEqual(["fork"]);
		// The reattach spawns exactly one more subprocess, on the binding's
		// account — not the HRW winner.
		expect(queries).toHaveLength(2);
		expect(cliAccountOf(queries[1]?.options?.env)).toBe(other);
		expect(cliAccountOf(queries[1]?.options?.env)).not.toBe(home);
		expect(getSession(SESSION)?.accountName).toBe(other);
	});

	it("aborting cuts a transient-retry wait short (item 1c)", async () => {
		await configure();
		// First submission succeeds (bootstrap); the second fails overloaded.
		// The deferred resolves when the overloaded result is served, so the
		// abort lands during the retry wait — aborting mid-attempt would take
		// the grace-timer path instead and prove nothing about the wait.
		let resolveSecondServed: () => void = () => {};
		const secondServed = new Promise<void>((resolve) => {
			resolveSecondServed = resolve;
		});
		const script: TurnScript = (sessionId, userUuid, submission) => {
			if (submission === 2) resolveSecondServed();
			return submission === 1
				? successScript(sessionId, userUuid, submission)
				: overloadedScript(sessionId, userUuid, submission);
		};
		await bootstrapOnOther(script);

		// Capture the real timer before faking: a real macrotask turn is the
		// only way to let the abort's rejection propagate past the fake clock.
		// (A race against an already-resolved "pending" always reports pending,
		// settled or not — the outcome must be read from a flag instead.)
		const realSetTimeout = setTimeout;
		vi.useFakeTimers();
		const controller = new AbortController();
		const completion = collectResidentTurn(secondTurnContext(), { signal: controller.signal });
		let outcome: string | undefined;
		void completion.then(
			() => {
				outcome = "resolved";
			},
			(error: unknown) => {
				outcome = error instanceof Error ? `rejected:${error.message}` : "rejected";
			},
		);
		// Wait until the overloaded result is served, then let the failure land
		// and the in-place retry wait start (500ms of fake time drains the
		// pump/queue chain without reaching the 1000ms wait).
		await secondServed;
		await vi.advanceTimersByTimeAsync(500);
		controller.abort();
		// Let the abort's rejection propagate on the real event loop. The fake
		// clock stays put: if the abort had not cut the 1000ms wait, the turn
		// would still be pending here.
		await new Promise((resolve) => realSetTimeout(resolve, 0));
		await new Promise((resolve) => realSetTimeout(resolve, 0));
		expect(outcome).toMatch(/^rejected:.*overloaded/i);
		await expect(completion).rejects.toThrow(/overloaded/i);
	});

	it("a non-main request follows the session's account (item 4)", async () => {
		// Summaries (and every other non-main request) take the direct
		// queryWithAuthLane branch in stream.ts: the scripted resident query
		// never ends its iterator, so this test uses a terminating stub like
		// the toolless-summary tests do.
		await configure();
		const calls: Options[] = [];
		const terminatingQuery: SdkQuery = ({ options }) => {
			calls.push(options ?? {});
			return {
				async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
					yield sdkMessage({
						type: "result",
						subtype: "success",
						is_error: false,
						result: "summary",
						stop_reason: "end_turn",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					});
				},
				interrupt: async () => {},
				close: () => {},
			};
		};
		overrideSdkBoundary({ query: terminatingQuery });
		overrideSessionRegistryBoundary({ queryFactory: terminatingQuery });
		// Seed the live entry directly: the summary only reads its account, so
		// no turn — and no fingerprint — is involved on this path.
		getOrCreateSession({
			senpiSessionId: SESSION,
			accountName: other,
			modelId: model.id,
			systemPromptHash: "seed",
			toolsetHash: "seed",
			options: { env: { CLAUDE_CONFIG_DIR: `/tmp/senpi-2987/${cliDirId(other)}` } },
		});

		const stream = streamAnthropicSubscription(model, firstTurnContext(), {
			cwd: process.cwd(),
			sessionId: SESSION,
			streamKind: "auxiliary",
		});
		for await (const _event of stream) {
			// Drain the provider stream before reading its result.
		}
		await stream.result();

		// [0] is the seeded live entry; [1] is the summary's own query.
		expect(calls).toHaveLength(2);
		expect(cliAccountOf(calls[1]?.env)).toBe(other);
		expect(cliAccountOf(calls[1]?.env)).not.toBe(home);
	});
});
