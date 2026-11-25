import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOAL_CONTINUATION_CAP } from "../../../src/core/extensions/builtin/goal/continuation.ts";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../src/core/messages.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

// senpi#4085: a goal that waits a limit out leaves one refused continuation in its session per wake. When that
// session was reopened, or a config reload retired its timer, the load-time flood guard counted those refused
// wakes as an unattended loop and left the goal waiting for a message.
const REFUSED_WAKES = GOAL_CONTINUATION_CAP + 4;
// senpi#7449: a startup or resume re-arms the refused wake's retry instead of asking again during start. These refusals
// are long past, so the wake comes after the restart floor plus the per-session spread (1 s + under 15 s).
const RESTART_WAKE_MS = 16_000;

type Answer = "rate limit" | "status-only 429" | "outage" | "served";
type Reopen = "startup" | "resume" | "reload";

const REFUSAL = {
	"rate limit": { category: "rate_limit", evidence: "structured_code", code: "rate_limit_error", httpStatus: 429 },
	"status-only 429": { category: "unknown", evidence: "structured_status", httpStatus: 429 },
	outage: { category: "provider_unavailable", evidence: "structured_status", httpStatus: 503 },
} as const;

function userEntry(): SessionEntry {
	return {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "a real user message" }], timestamp: 0 },
	} as unknown as SessionEntry;
}

const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function answerEntry(answer: Answer): SessionEntry {
	const outcome =
		answer === "served"
			? { content: [{ type: "text", text: "worked on the goal" }], stopReason: "stop" }
			: { content: [], stopReason: "error", errorMessage: "refused", providerDiagnostic: REFUSAL[answer] };
	const message = {
		role: "assistant",
		api: "faux",
		provider: "anthropic-subscription",
		model: "claude-opus-5-5",
		usage: NO_USAGE,
		timestamp: 0,
		...outcome,
	};
	return { type: "message", message } as unknown as SessionEntry;
}

function wake(...answers: Answer[]): SessionEntry[] {
	const continuation = {
		type: "custom_message",
		customType: GOAL_CONTINUATION_MESSAGE_TYPE,
		content: "continue the goal",
		display: false,
	} as unknown as SessionEntry;
	return [continuation, ...answers.map(answerEntry)];
}

function wakes(count: number, ...answers: Answer[]): SessionEntry[] {
	return Array.from({ length: count }, () => wake(...answers)).flat();
}

const openSessions: Array<() => Promise<void>> = [];

async function reopenGoalSession(
	thread: string,
	trailing: SessionEntry[],
	reason: Reopen = "startup",
	engineTurnsHeld = false,
) {
	const harness = createGoalHarness();
	const notices: string[] = [];
	const heldWakes: string[] = [];
	const ctx = await makeGoalContext(notices, thread);
	openSessions.push(() => runGoalHandlers(harness.handlers, "session_shutdown", { type: "session_shutdown" }, ctx));
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep working" }, undefined, undefined, ctx as ExtensionToolContext);
	const reopened = {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getBranch: () => [userEntry(), ...trailing] },
		engineTurnsHeld: () => engineTurnsHeld,
		noteHeldWake: (source: string) => heldWakes.push(source),
	} as ExtensionContext;

	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason }, reopened);

	const sent = () => harness.sent.map((message) => message.message.customType);
	const readReopenedGoal = () => readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
	const wakeAfterRestart = async () => {
		await vi.advanceTimersByTimeAsync(RESTART_WAKE_MS);
		await waitForSentCount(harness, 1, { timeoutMs: 5_000 });
	};
	return {
		sent: sent(),
		sentNow: sent,
		wakeAfterRestart,
		notices,
		heldWakes,
		goal: await readReopenedGoal(),
		readReopenedGoal,
	};
}

describe("a goal waiting out a limit resumes when its session is reopened (senpi#4085)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: Date.UTC(2026, 10, 25, 12, 0, 0) });
	});

	afterEach(async () => {
		for (const shutdown of openSessions.splice(0)) await shutdown();
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it.each(["startup", "resume", "reload"] as const)(
		"re-checks the limit on %s after more refused wakes than the continuation cap",
		async (reason) => {
			const reopened = await reopenGoalSession(
				`thread-4085-reopen-${reason}`,
				wakes(REFUSED_WAKES, "rate limit"),
				reason,
			);
			if (reason !== "reload") {
				expect(reopened.sentNow()).toEqual([]);
				await reopened.wakeAfterRestart();
			}

			expect(reopened.sentNow()).toEqual([GOAL_CONTINUATION_MESSAGE_TYPE]);
			expect(reopened.notices).toEqual([]);
			const goal = await reopened.readReopenedGoal();
			expect(goal?.status).toBe("active");
			expect(goal?.consecutiveContinuations ?? 0).toBe(0);
		},
	);

	it.each([
		["a status-only 429", ["status-only 429"]],
		["a ladder whose rungs failed for an outage and then a limit", ["outage", "rate limit"]],
	] as const)("does not count wakes refused by %s", async (_shape, answers) => {
		const reopened = await reopenGoalSession(
			`thread-4085-reopen-${answers.join("-")}`,
			wakes(REFUSED_WAKES, ...answers),
		);
		await reopened.wakeAfterRestart();

		expect(reopened.sentNow()).toEqual([GOAL_CONTINUATION_MESSAGE_TYPE]);
		expect(reopened.notices).toEqual([]);
	});

	// senpi#3853: a session reopened with no client attached runs no goal turn; the wake waits for the client.
	it("holds the re-check while the reopened session's engine turns are held", async () => {
		const { sent, heldWakes } = await reopenGoalSession(
			"thread-4085-reopen-held",
			wakes(REFUSED_WAKES, "rate limit"),
			"resume",
			true,
		);

		expect(sent).toEqual([]);
		expect(heldWakes).toEqual(["goal"]);
	});

	it("still holds back a flood of wakes the provider refused for an outage", async () => {
		const { sent, notices } = await reopenGoalSession("thread-4085-reopen-outage", wakes(REFUSED_WAKES, "outage"));

		expect(sent).toEqual([]);
		expect(notices).toHaveLength(1);
	});

	it("still holds back a flood of wakes that ran, whatever was refused after them", async () => {
		const { sent, notices } = await reopenGoalSession("thread-4085-reopen-ran", [
			...wakes(GOAL_CONTINUATION_CAP, "served"),
			...wakes(REFUSED_WAKES, "rate limit"),
		]);

		expect(sent).toEqual([]);
		expect(notices).toHaveLength(1);
	});

	it("counts the wake again once the newest one ran", async () => {
		const { sent, goal } = await reopenGoalSession("thread-4085-reopen-served-last", [
			...wakes(3, "rate limit"),
			...wake("served"),
		]);

		expect(sent).toEqual([GOAL_CONTINUATION_MESSAGE_TYPE]);
		expect(goal?.consecutiveContinuations).toBe(1);
	});
});
