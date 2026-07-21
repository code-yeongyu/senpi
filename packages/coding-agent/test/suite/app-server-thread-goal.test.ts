import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupRoots,
	createHarness,
	FakeConnection,
	objectAt,
	responseResult,
	threadIdFromResponse,
} from "./app-server-thread-handlers-harness.ts";

describe("app-server thread goal handlers", () => {
	afterEach(async () => {
		await cleanupRoots();
	});

	it("round-trips a goal and preserves omitted, null, and numeric token budgets", async () => {
		// Given: a started persistent thread.
		const { connection, registry, root } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 1, method: "thread/start", params: { cwd: root } }),
		);

		// When: a goal is created, updated without a budget, then explicitly cleared.
		const created = await registry.dispatch(connection, {
			id: 2,
			method: "thread/goal/set",
			params: { threadId, objective: "Ship the parity lane", tokenBudget: 4096 },
		});
		const preserved = await registry.dispatch(connection, {
			id: 3,
			method: "thread/goal/set",
			params: { threadId, status: "paused" },
		});
		const cleared = await registry.dispatch(connection, {
			id: 4,
			method: "thread/goal/set",
			params: { threadId, tokenBudget: null },
		});
		const read = await registry.dispatch(connection, {
			id: 5,
			method: "thread/goal/get",
			params: { threadId },
		});

		// Then: the goal shape and token-budget tri-state match the wire contract.
		expect(objectAt(responseResult(created), "goal")).toMatchObject({
			threadId,
			objective: "Ship the parity lane",
			status: "active",
			tokenBudget: 4096,
		});
		expect(objectAt(responseResult(preserved), "goal").tokenBudget).toBe(4096);
		expect(objectAt(responseResult(cleared), "goal").tokenBudget).toBeNull();
		expect(objectAt(responseResult(read), "goal").tokenBudget).toBeNull();
	});

	it.each([
		"blocked",
		"usageLimited",
		"budgetLimited",
	] as const)("rejects unsupported goal status %s with its exact invalid-request message", async (status) => {
		// Given: a started persistent thread.
		const { connection, registry, root } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 10, method: "thread/start", params: { cwd: root } }),
		);

		// When: the Codex-only status is supplied to thread/goal/set.
		const response = await registry.dispatch(connection, {
			id: 11,
			method: "thread/goal/set",
			params: { threadId, objective: "Reject this", status },
		});

		// Then: the server returns the pinned invalid-request category and message.
		expect(response).toEqual({
			id: 11,
			error: { code: -32600, message: `unsupported goal status: ${status}` },
		});
	});

	it("broadcasts goal updates globally only after the response", async () => {
		// Given: two initialized connections, with only the requester subscribed to the thread.
		const deferredActions: Array<() => Promise<void> | void> = [];
		const { connection, registry, notifications, root } = await createHarness({
			deferUntilResponded: (_connectionId, action) => {
				deferredActions.push(action);
				return true;
			},
		});
		const other = new FakeConnection("conn-2");
		notifications.addConnection(other);
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 20, method: "thread/start", params: { cwd: root } }),
		);
		connection.received.length = 0;
		other.received.length = 0;
		deferredActions.length = 0;

		// When: a goal update is dispatched and its deferred action is held.
		const response = await registry.dispatch(connection, {
			id: 21,
			method: "thread/goal/set",
			params: { threadId, objective: "Broadcast after response" },
		});

		// Then: no recipient sees the notification until the response has been produced.
		expect(response).toMatchObject({ id: 21, result: { goal: { threadId } } });
		expect(deferredActions).toHaveLength(1);
		expect(connection.received).toEqual([]);
		expect(other.received).toEqual([]);

		await deferredActions[0]?.();
		expect(connection.received).toEqual([
			{
				method: "thread/goal/updated",
				params: {
					threadId,
					turnId: null,
					goal: {
						threadId,
						objective: "Broadcast after response",
						status: "active",
						tokenBudget: null,
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: expect.any(Number),
						updatedAt: expect.any(Number),
					},
				},
				emittedAtMs: expect.any(Number),
			},
		]);
		expect(other.received).toEqual(connection.received);
	});

	it("emits cleared only when a goal actually existed", async () => {
		// Given: a persistent thread and one stored goal.
		const { connection, registry, root } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 30, method: "thread/start", params: { cwd: root } }),
		);
		await registry.dispatch(connection, {
			id: 31,
			method: "thread/goal/set",
			params: { threadId, objective: "Clear me" },
		});
		connection.received.length = 0;

		// When: the existing goal is cleared, then a missing goal is cleared again.
		const first = await registry.dispatch(connection, {
			id: 32,
			method: "thread/goal/clear",
			params: { threadId },
		});
		const firstNotifications = [...connection.received];
		connection.received.length = 0;
		const second = await registry.dispatch(connection, {
			id: 33,
			method: "thread/goal/clear",
			params: { threadId },
		});

		// Then: only the first clear broadcasts the global cleared notification.
		expect(first).toEqual({ id: 32, result: { cleared: true } });
		expect(firstNotifications.map((notification) => notification.method)).toEqual(["thread/goal/cleared"]);
		expect(second).toEqual({ id: 33, result: { cleared: false } });
		expect(connection.received).toEqual([]);
	});

	it("keeps a goal available after archive and resume", async () => {
		// Given: a goal stored on a loaded thread.
		const { connection, registry, root, threads } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 40, method: "thread/start", params: { cwd: root } }),
		);
		await registry.dispatch(connection, {
			id: 41,
			method: "thread/goal/set",
			params: { threadId, objective: "Survive resume" },
		});
		const sessionFile = threads.getLoadedThread(threadId).session.sessionFile;
		if (sessionFile === undefined) {
			throw new Error("goal persistence test requires a session file");
		}
		await writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: threadId, timestamp: new Date().toISOString(), cwd: root })}\n`,
			"utf8",
		);

		// When: the thread is archived and resumed before reading the goal.
		await registry.dispatch(connection, { id: 42, method: "thread/archive", params: { threadId } });
		await registry.dispatch(connection, { id: 43, method: "thread/resume", params: { threadId } });
		const response = await registry.dispatch(connection, {
			id: 44,
			method: "thread/goal/get",
			params: { threadId },
		});

		// Then: the shared goal store path returns the persisted goal after reload.
		expect(objectAt(responseResult(response), "goal")).toMatchObject({
			threadId,
			objective: "Survive resume",
			status: "active",
		});
		expect(threads.getLoadedThread(threadId).session.sessionFile).toBeTruthy();
	});
});
