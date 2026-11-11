import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitProviderAccountsChanged } from "../../../src/core/extensions/builtin/anthropic-subscription/account-events.ts";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

// senpi#4085 (goal side): every account of a pooled provider is out for a limit. The goal parks on the soonest reset
// and wakes; the pool refuses the wake while the accounts are still limited. Those refused wakes must not use up the
// continuation cap, a limit with no reset must still be re-checked, and a login or block reset must wake the goal.
const NOW = Date.UTC(2026, 10, 11, 8, 0);
const MINUTE = 60_000;
const TIMER_STATE = "goal_continuation_timer_state";

function refusal(resetsAt: number | undefined): AgentMessage {
	return {
		role: "assistant",
		content: [],
		api: "faux",
		provider: "anthropic-subscription",
		model: "claude-opus-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "You've hit your session limit",
		providerDiagnostic: {
			category: "rate_limit",
			evidence: "structured_code",
			code: "rate_limit_error",
			httpStatus: 429,
			...(resetsAt === undefined ? {} : { resetsAt }),
		},
		timestamp: Date.now(),
	};
}

async function goalSession(thread: string) {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, thread);
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "new" }, ctx);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep working" }, undefined, undefined, ctx as ExtensionToolContext);
	const refusedTurn = async (message: AgentMessage, fallbackExhausted?: { resumeAt?: number }) => {
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", aborted: false, willRetry: false, messages: [message] },
			ctx,
		);
		await runGoalHandlers(
			harness.handlers,
			"agent_settled",
			{ type: "agent_settled", ...(fallbackExhausted === undefined ? {} : { fallbackExhausted }) },
			ctx,
		);
	};
	const status = async () =>
		(await harness.tools.get("get_goal")?.execute("get", {}, undefined, undefined, ctx as ExtensionToolContext))
			?.details as { goal?: { status?: string } } | undefined;
	return { harness, refusedTurn, status };
}

function lastTimerState(harness: GoalHarness): unknown {
	return harness.events.emitted.filter((event) => event.channel === TIMER_STATE).at(-1)?.data;
}

describe("a goal outlasts accounts that stay limited (senpi#4085)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it.each(["lane refusal", "exhausted ladder"] as const)(
		"keeps waking past the continuation cap on a %s",
		async (shape) => {
			vi.useFakeTimers({ now: NOW });
			const { harness, refusedTurn, status } = await goalSession(`thread-4085-${shape}`);

			for (let wake = 1; wake <= 12; wake++) {
				const resetsAt = Date.now() + MINUTE;
				await refusedTurn(refusal(resetsAt), shape === "exhausted ladder" ? { resumeAt: resetsAt } : undefined);
				const sent = waitForSentCount(harness, wake);
				await vi.advanceTimersByTimeAsync(MINUTE + 1_001);
				await sent;
			}

			expect(harness.sent).toHaveLength(12);
			expect((await status())?.goal?.status).toBe("active");
		},
	);

	it("re-checks a limit-exhausted ladder that named no reset instead of waiting for input", async () => {
		vi.useFakeTimers({ now: NOW });
		const { harness, refusedTurn } = await goalSession("thread-4085-unknown-reset");

		await refusedTurn(refusal(undefined), {});

		expect(lastTimerState(harness)).toMatchObject({ armed: true, kind: "providerRetry" });
	});

	it.each(["login", "reset"] as const)("wakes a goal parked on a limit at once after a %s", async (remedy) => {
		vi.useFakeTimers({ now: NOW });
		const { harness, refusedTurn } = await goalSession(`thread-4085-${remedy}`);
		await refusedTurn(refusal(NOW + 3 * 60 * MINUTE));
		expect(harness.sent).toHaveLength(0);

		const sent = waitForSentCount(harness, 1);
		emitProviderAccountsChanged("anthropic-subscription", remedy);
		await vi.advanceTimersByTimeAsync(1_001);
		await sent;

		expect(harness.sent).toHaveLength(1);
		expect(lastTimerState(harness)).toMatchObject({ armed: false });
	});

	it("does not wake on an account change that is not a remedy", async () => {
		vi.useFakeTimers({ now: NOW });
		const { harness, refusedTurn } = await goalSession("thread-4085-no-remedy");
		await refusedTurn(refusal(NOW + 3 * 60 * MINUTE));

		emitProviderAccountsChanged("anthropic-subscription");
		await vi.advanceTimersByTimeAsync(60 * MINUTE);

		expect(harness.sent).toHaveLength(0);
		expect(lastTimerState(harness)).toMatchObject({ armed: true, kind: "providerRetry" });
	});
});
