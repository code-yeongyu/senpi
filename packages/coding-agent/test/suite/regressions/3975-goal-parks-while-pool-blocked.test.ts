import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COOLDOWN_BASE_MS } from "../../../src/core/credential-pool/classify.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { allAccountsBlockedDiagnostic } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import { terminalProviderAuthFailure } from "../../../src/core/extensions/builtin/goal/terminal-provider-error.ts";
import { providerFailureOf } from "../../../src/core/provider-failure.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

// senpi#3975: every slot of a pooled provider is blocked until a known instant. The goal must park until then
// (one notice naming the instant), send nothing before it, resume once after it, and never count the refused
// turns as a toolless stall. The refusal is built by the real pool engine behind the real lazy stream.
const NOW = Date.UTC(2026, 9, 22, 9, 0);
const HOUR = 60 * 60_000;
const STALL_MARKER = "<goal_stall_check>";
const STALL_EVENT = "goal_monitor_continuation_stall";

const MODEL = {
	id: "pool-model",
	name: "pool-model",
	api: "faux",
	provider: "pool-provider",
	baseUrl: "http://pool.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
} as unknown as Model<Api>;

const LIMIT_TEXT = "429 rate_limit_error: This request would exceed your account's rate limit.";
const poolDirs: string[] = [];

type ProbeRefusal = { readonly status: number; readonly text: string };
const LIMIT: ProbeRefusal = { status: 429, text: LIMIT_TEXT };

function limitEvent(refusal: ProbeRefusal = LIMIT): AssistantMessageEvent {
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: refusal.text,
		providerDiagnostic: { category: "unknown", httpStatus: refusal.status, evidence: "structured_status" },
		timestamp: Date.now(),
	};
	return { type: "error", reason: "error", error };
}

type ProbeAnswer = "event" | "throw";
type SlotBlock = { readonly name: string; readonly reason: "rate_limit" | "auth_error"; readonly until: number };

/**
 * The production pool behind the production lazy stream: persisted blocks, then the one cooling probe the
 * soonest rate-limited slot gets (senpi#3771), answered by the provider with a 429 event or a thrown error.
 */
async function blockedPoolTurn(
	blocks: readonly SlotBlock[],
	answer: ProbeAnswer = "event",
	refusal: ProbeRefusal = LIMIT,
): Promise<AssistantMessage> {
	const dir = mkdtempSync(join(tmpdir(), "senpi-3975-pool-"));
	poolDirs.push(dir);
	const repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	const credential: PooledCredential = {
		type: "api_key",
		key: "key-first",
		accounts: blocks.map((block) => ({ name: block.name, key: `key-${block.name}`, source: "login" as const })),
	};
	for (const block of blocks) {
		const credentialRevision = await repository.storedCredentialRevision(MODEL.provider, block.name, {
			key: `key-${block.name}`,
		});
		await repository.mutateSlotState(MODEL.provider, "stored", block.name, () => ({
			blockedUntil: block.until,
			blockReason: block.reason,
			failureCount: 1,
			credentialRevision,
		}));
	}
	const stream = lazyStream(MODEL, async () =>
		streamWithCredentialRotation({
			sources: { providerId: MODEL.provider, credential, env: () => undefined, repository, now: () => Date.now() },
			affinityKey: "session-3975",
			runAttempt: async function* () {
				if (answer === "throw") throw Object.assign(new Error(refusal.text), { status: refusal.status });
				yield limitEvent(refusal);
			},
		}),
	);
	return stream.result();
}

/**
 * Both slots hold a long stored block. The soonest one still gets the cooling probe; the provider refuses it with
 * no reset, so the pool re-blocks it for one backoff window and that window is the soonest any slot can serve.
 */
function probedRetryAt(now: number): number {
	return now + COOLDOWN_BASE_MS * 2;
}

function rateLimitedUntil(until: number): SlotBlock[] {
	return [
		{ name: "first", reason: "rate_limit", until },
		{ name: "second", reason: "rate_limit", until: until + HOUR },
	];
}

async function goalSessionWithLiveMonitor(thread: string) {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, thread);
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "new" }, ctx);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep working" }, undefined, undefined, ctx as ExtensionToolContext);
	harness.events.emit("terminal_monitor_state", { activeCount: 1 });
	await harness.events.flush();
	/** One refused turn as the session reports it: the failed attempt, its one same-turn retry, then settle. */
	const refusedTurn = async (message: AgentMessage) => {
		for (const willRetry of [true, false]) {
			await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				harness.handlers,
				"agent_end",
				{ type: "agent_end", aborted: false, willRetry, messages: [message] },
				ctx,
			);
		}
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
	};
	return { harness, ctx, notices, refusedTurn };
}

function stallEvents(harness: GoalHarness): unknown[] {
	return harness.events.emitted.filter((event) => event.channel === STALL_EVENT);
}

function pausedNotices(notices: readonly string[]): string[] {
	return notices.filter((notice) => notice.startsWith("Goal paused until"));
}

describe("goal parks while every pool slot is blocked (#3975)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
		for (const dir of poolDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each(["event", "throw"] as const)(
		"classifies the all-blocked %s refusal as a rate limit with the soonest unblock time",
		async (answer) => {
			vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
			const until = probedRetryAt(NOW);
			const message = await blockedPoolTurn(rateLimitedUntil(NOW + 2 * HOUR), answer);

			expect(message.stopReason).toBe("error");
			expect(message.providerDiagnostic).toMatchObject({ category: "rate_limit", resetsAt: until });
			expect(providerFailureOf([message])).toMatchObject({ category: "rate_limit", resetsAt: until });
		},
	);

	const NON_LIMIT_REFUSALS: ReadonlyArray<readonly [ProbeAnswer, ProbeRefusal]> = [
		["event", { status: 403, text: "403 permission_error: This organization has been disabled." }],
		["throw", { status: 403, text: "403 permission_error: This organization has been disabled." }],
		["event", { status: 402, text: "402 billing_error: Payment required." }],
		["event", { status: 404, text: "404 not_found_error: model not found" }],
	];

	it.each(NON_LIMIT_REFUSALS)(
		"keeps a cooling probe's %s %o refusal as the provider classified it, not as the pool's rate limit",
		async (answer, refusal) => {
			vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
			const message = await blockedPoolTurn(rateLimitedUntil(NOW + 2 * HOUR), answer, refusal);

			expect(message.providerDiagnostic?.category).not.toBe("rate_limit");
			if (answer === "event") expect(message.providerDiagnostic?.httpStatus).toBe(refusal.status);
			if (refusal.status === 403) {
				const event = { type: "agent_end" as const, messages: [message], willRetry: false };
				expect(terminalProviderAuthFailure(event)).toMatchObject({ httpStatus: 403 });
			}
		},
	);

	it("leaves a pool blocked only for re-authentication unclassified as a limit", async () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
		const message = await blockedPoolTurn([{ name: "only", reason: "auth_error", until: NOW + HOUR }]);

		expect(message.providerDiagnostic?.category).not.toBe("rate_limit");
	});

	it.each([
		["rate limits", ["rate_limit", "rate_limit"], true],
		["billing blocks", ["billing", "billing"], false],
		["organization refusals", ["org_not_allowed", "org_not_allowed"], false],
		["auth blocks", ["auth_error", "auth_error"], false],
		["mixed billing and rate limits", ["billing", "rate_limit"], false],
		["mixed organization and rate limits", ["org_not_allowed", "rate_limit"], false],
		["mixed auth and rate limits", ["auth_error", "rate_limit"], false],
		["unknown blocks", [undefined, undefined], false],
		["model limits", ["model_limit", "model_limit"], true],
		["mixed model and account limits", ["model_limit", "rate_limit"], true],
		["mixed model limits and billing", ["model_limit", "billing"], false],
	] as const)("classifies the Anthropic Subscription lane's %s refusal", (_label, reasons, isLimit) => {
		const until = NOW + 2 * HOUR;
		const accounts: AccountSlot[] = reasons.map((reason, index) => ({
			name: `synthetic-${index}`,
			source: "login",
			store: "claude-cli",
			dirId: index.toString(16).padStart(32, "0"),
			...(reason === "model_limit"
				? { modelBlocks: { [MODEL.id]: { blockedUntil: until } } }
				: { blockedUntil: until, blockReason: reason }),
		}));

		let refusal: unknown;
		try {
			selectAccount(accounts, { now: NOW, model: MODEL.id });
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(AllAccountsBlockedError);
		const diagnostic = allAccountsBlockedDiagnostic(refusal);
		if (isLimit) expect(diagnostic).toMatchObject({ category: "rate_limit", resetsAt: until });
		else expect(diagnostic).toBeUndefined();
	});

	it("does not infer an Anthropic rate limit from a deadline alone", () => {
		expect(allAccountsBlockedDiagnostic(new AllAccountsBlockedError(NOW + HOUR))).toBeUndefined();
		expect(allAccountsBlockedDiagnostic(new AllAccountsBlockedError(NOW + HOUR, "auth_error"))).toBeUndefined();
		expect(allAccountsBlockedDiagnostic(new AllAccountsBlockedError(undefined))).toBeUndefined();
	});

	it("sends nothing before the unblock time, one notice naming it, and one resume after it", async () => {
		vi.useFakeTimers({ now: NOW });
		const until = probedRetryAt(NOW);
		const { harness, notices, refusedTurn } = await goalSessionWithLiveMonitor("thread-3975-park");

		await refusedTurn(await blockedPoolTurn(rateLimitedUntil(NOW + 2 * HOUR)));
		await vi.advanceTimersByTimeAsync(until - NOW - 1);

		expect(harness.sent).toHaveLength(0);
		expect(stallEvents(harness)).toHaveLength(0);
		expect(pausedNotices(notices)).toHaveLength(1);
		expect(pausedNotices(notices)[0]).toContain(new Date(until).toISOString());

		const resumed = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(1_001);
		await resumed;
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.content).not.toContain(STALL_MARKER);
	});

	it("never counts refused turns toward the toolless stall check", async () => {
		vi.useFakeTimers({ now: NOW });
		const { harness, notices, refusedTurn } = await goalSessionWithLiveMonitor("thread-3975-no-stall");

		for (let block = 1; block <= 3; block++) {
			const until = probedRetryAt(Date.now());
			await refusedTurn(await blockedPoolTurn(rateLimitedUntil(Date.now() + block * HOUR)));
			const resumed = waitForSentCount(harness, block);
			await vi.advanceTimersByTimeAsync(until - Date.now() + 1_001);
			await resumed;
		}

		expect(harness.sent).toHaveLength(3);
		for (const sent of harness.sent) expect(sent.message.content).not.toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(0);
		expect(pausedNotices(notices)).toHaveLength(3);
	});
});
