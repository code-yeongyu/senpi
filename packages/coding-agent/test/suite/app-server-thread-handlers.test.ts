import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRegistry,
	type MethodRegistry,
	type RegistryConnection,
} from "../../src/modes/app-server/rpc/registry.ts";
import {
	NotificationRouter,
	type RoutableConnection,
	type RouterNotification,
} from "../../src/modes/app-server/server/notifications.ts";
import { registerThreadLifecycleHandlers } from "../../src/modes/app-server/threads/handlers.ts";
import { ThreadRegistry } from "../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";

const roots: string[] = [];

class FakeConnection implements RoutableConnection, RegistryConnection {
	readonly id: string;
	readonly transport = "ws";
	readonly received: RouterNotification[] = [];
	readonly capabilities = { experimentalApi: true };
	initialized = true;
	optOutNotificationMethods: readonly string[] | null = null;

	constructor(id = "conn-1") {
		this.id = id;
	}

	send(notification: RouterNotification): void {
		this.received.push(notification);
	}
}

async function scratchRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-app-server-thread-handlers-"));
	roots.push(root);
	return root;
}

async function createHarness(): Promise<{
	readonly connection: FakeConnection;
	readonly registry: MethodRegistry;
	readonly root: string;
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
}> {
	const root = await scratchRoot();
	const connection = new FakeConnection();
	const threads = new ThreadRegistry({
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
	});
	const notifications = new NotificationRouter({ connections: [connection] });
	const registry = createRegistry();
	const turnLog = new TurnLog();
	registerThreadLifecycleHandlers(registry, {
		threads,
		turnLog,
		notifications,
		idleUnloadMinutes: 5,
	});
	return { connection, registry, root, threads, turnLog };
}

describe("app-server thread lifecycle handlers", () => {
	afterEach(async () => {
		vi.useRealTimers();
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) {
				await rm(root, { recursive: true, force: true });
			}
		}
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

	it("archives a thread, unloads it, and filters archived listings", async () => {
		// Given: two started threads.
		const { connection, registry, root, threads } = await createHarness();
		const archived = threadIdFromResponse(
			await registry.dispatch(connection, { id: 16, method: "thread/start", params: { cwd: root } }),
		);
		const active = threadIdFromResponse(
			await registry.dispatch(connection, { id: 17, method: "thread/start", params: { cwd: root } }),
		);
		connection.received.length = 0;

		// When: one thread is archived and both list filters are read.
		await expect(
			registry.dispatch(connection, { id: 18, method: "thread/archive", params: { threadId: archived } }),
		).resolves.toEqual({ id: 18, result: {} });
		const defaultList = await registry.dispatch(connection, { id: 19, method: "thread/list", params: {} });
		const archivedList = await registry.dispatch(connection, {
			id: 20,
			method: "thread/list",
			params: { archived: true },
		});

		// Then: archive emits the typed notification, unloads the runtime, and list filters by archive state.
		expect(connection.received).toEqual([{ method: "thread/archived", params: { threadId: archived } }]);
		expect(() => threads.getLoadedThread(archived)).toThrow();
		expect(threadIdsFromList(defaultList)).toContain(active);
		expect(threadIdsFromList(defaultList)).not.toContain(archived);
		expect(threadIdsFromList(archivedList)).toEqual([archived]);
	});

	it("deletes a thread and removes it from loaded/list responses", async () => {
		// Given: a started thread.
		const { connection, registry, root } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 21, method: "thread/start", params: { cwd: root } }),
		);
		connection.received.length = 0;

		// When: the thread is deleted and list surfaces are queried.
		await expect(
			registry.dispatch(connection, { id: 22, method: "thread/delete", params: { threadId } }),
		).resolves.toEqual({ id: 22, result: {} });
		const loaded = await registry.dispatch(connection, { id: 23, method: "thread/loaded/list", params: {} });
		const listed = await registry.dispatch(connection, { id: 24, method: "thread/list", params: {} });

		// Then: the delete notification is broadcast and the thread no longer appears.
		expect(connection.received).toEqual([{ method: "thread/deleted", params: { threadId } }]);
		expect(dataArray(responseResult(loaded))).not.toContain(threadId);
		expect(threadIdsFromList(listed)).not.toContain(threadId);
	});

	it("paginates thread/loaded/list over loaded thread ids", async () => {
		// Given: two loaded threads.
		const { connection, registry, root } = await createHarness();
		const first = threadIdFromResponse(
			await registry.dispatch(connection, { id: 25, method: "thread/start", params: { cwd: root } }),
		);
		const second = threadIdFromResponse(
			await registry.dispatch(connection, { id: 26, method: "thread/start", params: { cwd: root } }),
		);

		// When: loaded threads are listed one at a time.
		const pageOne = await registry.dispatch(connection, {
			id: 27,
			method: "thread/loaded/list",
			params: { limit: 1 },
		});
		const pageOneResult = responseResult(pageOne);
		const nextCursor = pageOneResult.nextCursor;
		const pageTwo = await registry.dispatch(connection, {
			id: 28,
			method: "thread/loaded/list",
			params: { cursor: typeof nextCursor === "string" ? nextCursor : null, limit: 1 },
		});

		// Then: both loaded ids are returned across the pages.
		expect([...dataArray(pageOneResult), ...dataArray(responseResult(pageTwo))].sort()).toEqual(
			[first, second].sort(),
		);
	});

	it("replays pending approvals on warm resume", async () => {
		// Given: a loaded thread and a replay hook.
		const { root, threads } = await createHarness();
		const connection = new FakeConnection("conn-2");
		const entry = await threads.createThread({ cwd: root });
		const notifications = new NotificationRouter({ connections: [connection], threads: [entry] });
		const handlerRegistry = createRegistry();
		const replays: string[] = [];
		registerThreadLifecycleHandlers(handlerRegistry, {
			threads,
			turnLog: new TurnLog(),
			notifications,
			replayPendingApprovals: (threadId, targetConnectionId) => {
				replays.push(`${threadId}:${targetConnectionId}`);
			},
		});

		// When: the connection resumes the loaded thread.
		await handlerRegistry.dispatch(connection, {
			id: 29,
			method: "thread/resume",
			params: { threadId: entry.id },
		});

		// Then: pending approval replay is invoked for the new subscriber.
		expect(replays).toEqual([`${entry.id}:conn-2`]);
	});

	it("reconstructs synthetic turns when cold thread/read includes turns", async () => {
		// Given: a persisted session file with two user messages and no live turn log.
		const root = await scratchRoot();
		const sessionDir = join(root, "sessions");
		await mkdir(sessionDir, { recursive: true });
		const threadId = "22222222-2222-4222-8222-222222222222";
		const sessionFile = join(sessionDir, `2026-07-02T00-00-00-000Z_${threadId}.jsonl`);
		await writeFile(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: threadId,
					timestamp: "2026-07-02T00:00:00.000Z",
					cwd: root,
				}),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: threadId,
					timestamp: "2026-07-02T00:00:01.000Z",
					message: { role: "user", content: [{ type: "text", text: "first" }] },
				}),
				JSON.stringify({
					type: "message",
					id: "msg-2",
					parentId: "msg-1",
					timestamp: "2026-07-02T00:00:02.000Z",
					message: { role: "user", content: [{ type: "text", text: "second" }] },
				}),
				"",
			].join("\n"),
		);
		const connection = new FakeConnection();
		const threads = new ThreadRegistry({ agentDir: join(root, "agent"), sessionDir });
		const registry = createRegistry();
		registerThreadLifecycleHandlers(registry, {
			threads,
			turnLog: new TurnLog(),
			notifications: new NotificationRouter({ connections: [connection] }),
		});

		// When: the cold thread is read with turns included.
		const response = await registry.dispatch(connection, {
			id: 30,
			method: "thread/read",
			params: { threadId, includeTurns: true },
		});

		// Then: synthetic turns are materialized from persisted user messages.
		const turns = dataArray(objectAt(responseResult(response), "thread"), "turns");
		expect(turns.map((turn) => objectValue(turn).id)).toEqual(["turn-1", "turn-2"]);
	});

	it("unloads idle threads after the configured no-subscriber delay", async () => {
		vi.useFakeTimers();
		// Given: a started thread becomes idle with no subscribers.
		const { connection, registry, root } = await createHarness();
		const started = await registry.dispatch(connection, { id: 9, method: "thread/start", params: { cwd: root } });
		const threadId = stringAt(objectAt(responseResult(started), "thread"), "id");
		await registry.dispatch(connection, { id: 10, method: "thread/unsubscribe", params: { threadId } });
		connection.received.length = 0;

		// When: the idle-unload timer elapses.
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

		// Then: lifecycle notifications announce closure and notLoaded status.
		expect(connection.received).toEqual([
			{ method: "thread/closed", params: { threadId } },
			{ method: "thread/status/changed", params: { threadId, status: { type: "notLoaded" } } },
		]);
	});
});

function responseResult(response: Awaited<ReturnType<MethodRegistry["dispatch"]>>): Record<string, unknown> {
	if ("error" in response) {
		throw new Error(response.error.message);
	}
	return objectValue(response.result);
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
	const object = objectValue(value);
	return objectValue(object[key]);
}

function stringAt(value: unknown, key: string): string {
	const object = objectValue(value);
	const child = object[key];
	if (typeof child !== "string") {
		throw new Error(`Expected ${key} to be a string`);
	}
	return child;
}

function threadIdFromResponse(response: Awaited<ReturnType<MethodRegistry["dispatch"]>>): string {
	return stringAt(objectAt(responseResult(response), "thread"), "id");
}

function threadIdsFromList(response: Awaited<ReturnType<MethodRegistry["dispatch"]>>): string[] {
	return dataArray(responseResult(response)).map((thread) => stringAt(thread, "id"));
}

function dataArray(value: unknown, key = "data"): unknown[] {
	const object = objectValue(value);
	const child = object[key];
	if (!Array.isArray(child)) {
		throw new Error(`Expected ${key} to be an array`);
	}
	return child;
}

function objectValue(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected an object");
	}
	return Object.fromEntries(Object.entries(value));
}
