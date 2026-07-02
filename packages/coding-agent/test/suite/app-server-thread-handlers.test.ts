import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { NotificationRouter } from "../../src/modes/app-server/server/notifications.ts";
import { registerThreadLifecycleHandlers } from "../../src/modes/app-server/threads/handlers.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	cleanupRoots,
	createHarness,
	objectAt,
	responseResult,
	stringAt,
	threadIdFromResponse,
} from "./app-server-thread-handlers-harness.ts";

describe("app-server thread lifecycle handlers", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupRoots();
	});

	it("returns generated Thread-shaped start responses and subscribes the requesting connection", async () => {
		// Given: a registered lifecycle handler set and an initialized app-server connection.
		const { connection, registry, root, threads } = await createHarness();

		// When: the connection starts a thread.
		const response = await registry.dispatch(connection, {
			id: 1,
			method: "thread/start",
			params: { cwd: root },
		});

		// Then: the response has the generated Thread-required fields and the connection is subscribed.
		expect(response).not.toHaveProperty("error");
		expect(response).toMatchObject({
			id: 1,
			result: {
				serviceTier: null,
				cwd: root,
				runtimeWorkspaceRoots: [root],
				instructionSources: [],
				approvalPolicy: "never",
				approvalsReviewer: "user",
				sandbox: { type: "dangerFullAccess" },
				activePermissionProfile: null,
				multiAgentMode: "explicitRequestOnly",
				thread: {
					preview: "",
					ephemeral: false,
					forkedFromId: null,
					parentThreadId: null,
					status: { type: "idle" },
					cwd: root,
					source: "appServer",
					threadSource: null,
					agentNickname: null,
					agentRole: null,
					gitInfo: null,
					name: null,
					turns: [],
				},
			},
		});
		const result = responseResult(response);
		expect(typeof result.modelProvider).toBe("string");
		expect(typeof result.reasoningEffort).toBe("string");
		const thread = objectAt(result, "thread");
		expect(typeof thread.path === "string" || thread.path === null).toBe(true);
		const threadId = stringAt(thread, "id");
		expect(threads.getLoadedThread(threadId).subscribers.has(connection.id)).toBe(true);
	});

	it("returns the exact unknown rollout text when resuming a missing thread", async () => {
		// Given: no registry entry or disk session for the requested thread id.
		const { connection, registry } = await createHarness();
		const threadId = "11111111-1111-1111-1111-111111111111";

		// When: the connection resumes an unknown thread.
		const response = await registry.dispatch(connection, {
			id: 2,
			method: "thread/resume",
			params: { threadId },
		});

		// Then: the JSON-RPC error text matches the Codex app contract exactly.
		expect(response).toEqual({
			id: 2,
			error: { code: -32603, message: `no rollout found for thread id ${threadId}` },
		});
	});

	it("subscribes warm resume and flushes queued terminal notifications", async () => {
		// Given: a warm loaded thread with a terminal notification queued while nobody is subscribed.
		const { connection, root, threads } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		const notifications = new NotificationRouter({ connections: [connection], threads: [entry] });
		const handlerRegistry = createRegistry();
		registerThreadLifecycleHandlers(handlerRegistry, {
			threads,
			turnLog: new TurnLog(),
			notifications,
			idleUnloadMinutes: 5,
		});
		notifications.toThread(entry.id, {
			method: "turn/completed",
			params: { threadId: entry.id, turn: { id: "turn-1" } },
		});

		// When: the connection resumes that warm thread.
		const response = await handlerRegistry.dispatch(connection, {
			id: 3,
			method: "thread/resume",
			params: { threadId: entry.id },
		});

		// Then: the queued terminal notification flushes to the connection before live use continues.
		expect(response).not.toHaveProperty("error");
		expect(connection.received.map((notification) => notification.method)).toEqual(["turn/completed"]);
		expect(entry.queuedTerminalNotifications).toEqual([]);
		expect(entry.subscribers.has(connection.id)).toBe(true);
	});

	it("reports unsubscribe as unsubscribed, notSubscribed, and notLoaded", async () => {
		// Given: a connection subscribed by thread/start.
		const { connection, registry, root } = await createHarness();
		const started = await registry.dispatch(connection, { id: 4, method: "thread/start", params: { cwd: root } });
		const threadId = stringAt(objectAt(responseResult(started), "thread"), "id");

		// When/Then: unsubscribe reports every stable state.
		await expect(
			registry.dispatch(connection, { id: 5, method: "thread/unsubscribe", params: { threadId } }),
		).resolves.toEqual({ id: 5, result: { status: "unsubscribed" } });
		await expect(
			registry.dispatch(connection, { id: 6, method: "thread/unsubscribe", params: { threadId } }),
		).resolves.toEqual({ id: 6, result: { status: "notSubscribed" } });
		await expect(
			registry.dispatch(connection, { id: 7, method: "thread/unsubscribe", params: { threadId: "missing-thread" } }),
		).resolves.toEqual({ id: 7, result: { status: "notLoaded" } });
	});

	it("serves thread/read from the shared turn log without subscribing", async () => {
		// Given: a loaded thread with a recorded turn and no subscribers.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		turnLog.recordTurn(entry.id, {
			turnId: "turn-1",
			startedAt: "2026-07-02T00:00:00.000Z",
			status: "completed",
		});
		turnLog.appendItem(entry.id, "turn-1", { id: "item-1", type: "userMessage", content: [] });

		// When: the connection reads the thread with turns included.
		const response = await registry.dispatch(connection, {
			id: 8,
			method: "thread/read",
			params: { threadId: entry.id, includeTurns: true },
		});

		// Then: turns come from the shared log and the connection remains unsubscribed.
		expect(response).not.toHaveProperty("error");
		expect(response).toMatchObject({
			id: 8,
			result: {
				thread: {
					id: entry.id,
					turns: [
						{
							id: "turn-1",
							itemsView: "full",
							status: "completed",
							error: null,
							startedAt: 1782950400,
							completedAt: null,
							durationMs: null,
						},
					],
				},
			},
		});
		expect(threads.getLoadedThread(entry.id).subscribers.has(connection.id)).toBe(false);
	});

	it("returns fork origin and subscribes the forked thread", async () => {
		// Given: a source thread already started by the connection.
		const { connection, registry, root, threads } = await createHarness();
		const started = await registry.dispatch(connection, { id: 11, method: "thread/start", params: { cwd: root } });
		const sourceThreadId = threadIdFromResponse(started);

		// When: the connection forks that source thread.
		const forked = await registry.dispatch(connection, {
			id: 12,
			method: "thread/fork",
			params: { threadId: sourceThreadId },
		});

		// Then: the response names the fork origin and the fork is loaded/subscribed.
		expect(forked).not.toHaveProperty("error");
		const forkedThread = objectAt(responseResult(forked), "thread");
		const forkedThreadId = stringAt(forkedThread, "id");
		expect(forkedThread.forkedFromId).toBe(sourceThreadId);
		expect(threads.getLoadedThread(forkedThreadId).subscribers.has(connection.id)).toBe(true);
	});

	it("round-trips thread/name/set through broadcast and read", async () => {
		// Given: a started thread.
		const { connection, registry, root } = await createHarness();
		const started = await registry.dispatch(connection, { id: 13, method: "thread/start", params: { cwd: root } });
		const threadId = threadIdFromResponse(started);
		connection.received.length = 0;

		// When: the thread name is set and the thread is read.
		await expect(
			registry.dispatch(connection, {
				id: 14,
				method: "thread/name/set",
				params: { threadId, name: "Todo 12" },
			}),
		).resolves.toEqual({ id: 14, result: {} });
		const read = await registry.dispatch(connection, { id: 15, method: "thread/read", params: { threadId } });

		// Then: the broadcast and read response expose the new name.
		expect(connection.received).toEqual([
			{ method: "thread/name/updated", params: { threadId, threadName: "Todo 12" } },
		]);
		expect(objectAt(responseResult(read), "thread").name).toBe("Todo 12");
	});
});
