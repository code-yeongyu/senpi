import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_CONTINUATION_SCHEDULED_EVENT } from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";

function userMessageEntry(): SessionEntry {
	return {
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text: "a real user message" }],
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function goalContinuationEntries(count: number): SessionEntry[] {
	return Array.from({ length: count }, () => ({
		type: "custom_message",
		customType: GOAL_CONTINUATION_MESSAGE_TYPE,
		content: "continue the goal",
		display: false,
	})) as unknown as SessionEntry[];
}

function goalWithStatus(id: string, status: Goal["status"]): Goal {
	return {
		id,
		threadId: `${id}-thread`,
		objective: "Keep moving across a config reload",
		status,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function storeRefFor(ctx: ExtensionContext): { baseDir: string; threadId: string } {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function withBranchEntries(ctx: ExtensionContext, entries: SessionEntry[]): ExtensionContext {
	return {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getBranch: () => entries },
	} as ExtensionContext;
}

describe("goal reload re-engagement (issue #934)", () => {
	afterEach(async () => {
		await cleanupGoalMonitorTempDirs();
	});

	it("queues a continuation on reload for an active goal without wake sources", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-934-active-reload");
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);
		expect(sent).toHaveLength(0);

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe(GOAL_CONTINUATION_MESSAGE_TYPE);
	});

	it("re-arms the monitor backstop on reload while wake sources are live", async () => {
		vi.useFakeTimers();
		try {
			const { tools, handlers, events, sent } = createGoalHarness();
			const notices: string[] = [];
			const ctx = await makeGoalContext(notices, "thread-934-wake-reload");
			await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);
			events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 1 });
			await events.flush();

			await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

			const scheduled = events.emitted.filter((event) => event.channel === GOAL_CONTINUATION_SCHEDULED_EVENT);
			expect(scheduled).toHaveLength(1);
			expect(sent).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers the continuation when wake sources drain after a reload re-arm", async () => {
		vi.useFakeTimers();
		try {
			const harness = createGoalHarness();
			const { tools, handlers, events, sent } = harness;
			const notices: string[] = [];
			const ctx = await makeGoalContext(notices, "thread-934-drain-reload");
			await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);
			events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 1 });
			await events.flush();
			await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
			expect(sent).toHaveLength(0);

			events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 0 });
			await events.flush();
			await vi.advanceTimersByTimeAsync(1_000);

			await waitForSentCount(harness, 1, { timeoutMs: 2_000 });
			expect(sent[0]?.message.customType).toBe(GOAL_CONTINUATION_MESSAGE_TYPE);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not re-engage a blocked goal on reload", async () => {
		const { tools, handlers, events, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-934-blocked-reload");
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);
		await tools
			.get("update_goal")
			?.execute("u1", { status: "blocked", reason: "user interrupted the turn" }, undefined, undefined, ctx);

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		expect(sent).toHaveLength(0);
		expect(events.emitted.filter((event) => event.channel === GOAL_CONTINUATION_SCHEDULED_EVENT)).toHaveLength(0);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("blocked");
	});

	it("does not re-engage a paused goal on reload", async () => {
		const { handlers, events, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-934-paused-reload");
		await writeGoal(storeRefFor(ctx), goalWithStatus("thread-934-paused-reload", "paused"));

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		expect(sent).toHaveLength(0);
		expect(events.emitted.filter((event) => event.channel === GOAL_CONTINUATION_SCHEDULED_EVENT)).toHaveLength(0);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("paused");
	});

	it("suppresses with a notice on reload when the branch ends in a continuation flood", async () => {
		const { tools, handlers, sent } = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-934-flooded-reload");
		await tools.get("create_goal")?.execute("c1", { objective: "Keep going" }, undefined, undefined, ctx);
		const floodedCtx = withBranchEntries(ctx, [userMessageEntry(), ...goalContinuationEntries(300)]);

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, floodedCtx);

		expect(sent).toHaveLength(0);
		expect(notices).toContainEqual(
			"Goal auto-continuation suppressed for this resumed session (300 historical continuations). Send a message to resume.",
		);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");
	});
});
