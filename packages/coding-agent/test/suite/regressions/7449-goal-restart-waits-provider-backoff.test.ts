/**
 * senpi#7449: a goal whose last turn ended on a provider 429 was waiting out its provider-retry backoff when the host
 * stopped. The next host start opened the session and the goal queued its continuation at once, so the session sent
 * another request into the same limit, and every such session on the host did it in the same instant. A restart now
 * re-arms the retry wait, measured from the failed answer and spread per session; a healthy goal still continues at
 * once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../src/core/messages.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
// A status-only 429 is a limit refusal, so its first re-check waits the 15 s provider backoff floor.
const LIMIT_BACKOFF_MS = 15_000;
const RESTART_FLOOR_MS = 1_000;
const SPREAD_MS = 15_000;

function expectWakeWithin(dueAtMs: number | undefined, earliest: number): number {
	expect(dueAtMs).toBeGreaterThanOrEqual(earliest);
	expect(dueAtMs).toBeLessThan(earliest + SPREAD_MS);
	return dueAtMs as number;
}

function userEntry(): SessionEntry {
	return {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "keep going" }], timestamp: NOW - 60 * 60_000 },
	} as unknown as SessionEntry;
}

function answerEntry(ended: "429" | "stop", timestamp: number): SessionEntry {
	const base = cleanAssistantStop();
	const outcome =
		ended === "stop"
			? {}
			: {
					content: [],
					stopReason: "error",
					errorMessage: "429 Too Many Requests",
					providerDiagnostic: { category: "unknown", evidence: "structured_status", httpStatus: 429 },
				};
	return { type: "message", message: { ...base, ...outcome, timestamp } } as unknown as SessionEntry;
}

const openSessions: Array<() => Promise<void>> = [];

async function restartGoalSession(thread: string, branch: SessionEntry[]) {
	const harness = createGoalHarness();
	const ctx = await makeGoalContext([], thread);
	openSessions.push(() => runGoalHandlers(harness.handlers, "session_shutdown", { type: "session_shutdown" }, ctx));
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep working" }, undefined, undefined, ctx as ExtensionToolContext);
	const restarted = {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getBranch: () => branch },
	} as ExtensionContext;
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "startup" }, restarted);
	const sent = () => harness.sent.filter((s) => s.message.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length;
	const armedRetry = () =>
		harness.events.emitted
			.filter((event) => event.channel === "goal_continuation_timer_state")
			.map((event) => event.data as { armed: boolean; kind: string; dueAtMs?: number })
			.filter((data) => data.armed && data.kind === "providerRetry")
			.at(-1);
	const retryFired = () =>
		harness.events.emitted.some(
			(event) =>
				event.channel === "goal_continuation_timer_state" &&
				(event.data as { armed: boolean; kind: string }).kind === "providerRetry" &&
				!(event.data as { armed: boolean }).armed,
		);
	const firstWake = () => waitForSentCount(harness, 1, { timeoutMs: 5_000 });
	return { sent, armedRetry, retryFired, firstWake };
}

describe("a host restart waits out a goal's provider backoff (senpi#7449)", () => {
	afterEach(async () => {
		for (const shutdown of openSessions.splice(0)) await shutdown();
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("sends nothing at start and continues once when the backoff left at the failure runs out", async () => {
		vi.useFakeTimers({ now: NOW });
		const failedAt = NOW - 5_000;
		const session = await restartGoalSession("thread-7449-goal-backoff", [userEntry(), answerEntry("429", failedAt)]);

		expect(session.sent()).toBe(0);
		const dueAt = expectWakeWithin(session.armedRetry()?.dueAtMs, failedAt + LIMIT_BACKOFF_MS);
		await vi.advanceTimersByTimeAsync(dueAt - NOW - 1);
		expect(session.retryFired()).toBe(false);
		expect(session.sent()).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await session.firstWake();
		expect(session.sent()).toBe(1);
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(session.sent()).toBe(1);
	});

	it("fires once after the restart floor when the backoff already ran out, never during start", async () => {
		vi.useFakeTimers({ now: NOW });
		const session = await restartGoalSession("thread-7449-goal-elapsed", [
			userEntry(),
			answerEntry("429", NOW - 10 * 60_000),
		]);

		expect(session.sent()).toBe(0);
		const dueAt = expectWakeWithin(session.armedRetry()?.dueAtMs, NOW + RESTART_FLOOR_MS);
		await vi.advanceTimersByTimeAsync(dueAt - NOW - 1);
		expect(session.retryFired()).toBe(false);
		expect(session.sent()).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await session.firstWake();
		expect(session.sent()).toBe(1);
	});

	it("spreads sessions that failed in the same instant over different wake times", async () => {
		vi.useFakeTimers({ now: NOW });
		const failedAt = NOW - 2_000;
		const first = await restartGoalSession("thread-7449-goal-a", [userEntry(), answerEntry("429", failedAt)]);
		const second = await restartGoalSession("thread-7449-goal-b", [userEntry(), answerEntry("429", failedAt)]);

		const firstDue = expectWakeWithin(first.armedRetry()?.dueAtMs, failedAt + LIMIT_BACKOFF_MS);
		const secondDue = expectWakeWithin(second.armedRetry()?.dueAtMs, failedAt + LIMIT_BACKOFF_MS);
		expect(firstDue).not.toBe(secondDue);
	});

	it("still continues a goal whose newest answer ended cleanly at once", async () => {
		vi.useFakeTimers({ now: NOW });
		const session = await restartGoalSession("thread-7449-goal-healthy", [
			userEntry(),
			answerEntry("stop", NOW - 5_000),
		]);

		expect(session.sent()).toBe(1);
		expect(session.armedRetry()).toBeUndefined();
	});
});
