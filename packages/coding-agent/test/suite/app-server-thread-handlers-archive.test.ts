import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { NotificationRouter } from "../../src/modes/app-server/server/notifications.ts";
import { registerThreadLifecycleHandlers } from "../../src/modes/app-server/threads/handlers.ts";
import { ThreadRegistry } from "../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	cleanupRoots,
	createHarness,
	dataArray,
	FakeConnection,
	objectAt,
	objectValue,
	responseResult,
	threadIdFromResponse,
	threadIdsFromList,
	writePersistedSession,
} from "./app-server-thread-handlers-harness.ts";

describe("app-server thread archive lifecycle handlers", () => {
	afterEach(async () => {
		await cleanupRoots();
	});

	it("persists archived filtering across a fresh handler registry", async () => {
		// Given: a persisted session archived by one handler instance.
		const { connection, registry, root } = await createHarness();
		const threadId = "33333333-3333-4333-8333-333333333333";
		await writePersistedSession(root, threadId);
		await expect(
			registry.dispatch(connection, { id: 1, method: "thread/archive", params: { threadId } }),
		).resolves.toEqual({ id: 1, result: {} });

		// When: a fresh registry lists threads from the same session directory.
		const freshConnection = new FakeConnection("fresh-conn");
		const freshRegistry = createRegistry();
		const freshThreads = new ThreadRegistry({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") });
		registerThreadLifecycleHandlers(freshRegistry, {
			threads: freshThreads,
			turnLog: new TurnLog(),
			notifications: new NotificationRouter({ connections: [freshConnection] }),
		});
		const defaultList = await freshRegistry.dispatch(freshConnection, { id: 2, method: "thread/list", params: {} });
		const archivedList = await freshRegistry.dispatch(freshConnection, {
			id: 3,
			method: "thread/list",
			params: { archived: true },
		});

		// Then: persisted archive state, not handler memory, controls both filters.
		expect(threadIdsFromList(defaultList)).not.toContain(threadId);
		expect(threadIdsFromList(archivedList)).toEqual([threadId]);
	});

	it("surfaces corrupt archived sidecars as an internal error", async () => {
		// Given: a persisted session with a malformed archive sidecar.
		const { connection, registry, root } = await createHarness();
		const threadId = "44444444-4444-4444-8444-444444444444";
		await writePersistedSession(root, threadId);
		const sessionPath = join(root, "sessions", `2026-07-02T00-00-00-000Z_${threadId}.jsonl`);
		await writeFile(`${sessionPath}.archived`, "{not json", "utf8");

		// When: archived threads are listed through the registry.
		const response = await registry.dispatch(connection, {
			id: 4,
			method: "thread/list",
			params: { archived: true },
		});

		// Then: corrupt state is surfaced instead of being treated as absent.
		expect(response).toEqual({
			id: 4,
			error: {
				code: -32603,
				message: expect.stringContaining(`${sessionPath}.archived`),
			},
		});
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
		expect(connection.received).toEqual([
			{ method: "thread/archived", params: { threadId: archived }, emittedAtMs: expect.any(Number) },
		]);
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
		expect(connection.received).toEqual([
			{ method: "thread/deleted", params: { threadId }, emittedAtMs: expect.any(Number) },
		]);
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

	it("unarchives storage-only with notLoaded status before an explicit resume", async () => {
		// Given: a persisted thread that is archived and therefore unloaded.
		const deferredActions: Array<() => Promise<void> | void> = [];
		const { connection, registry, root, threads } = await createHarness({
			deferUntilResponded: (_connectionId, action) => {
				deferredActions.push(action);
				return true;
			},
		});
		const threadId = "55555555-5555-4555-8555-555555555555";
		await writePersistedSession(root, threadId);
		await registry.dispatch(connection, { id: 31, method: "thread/archive", params: { threadId } });
		connection.received.length = 0;
		const archived = await registry.dispatch(connection, {
			id: 32,
			method: "thread/list",
			params: { archived: true },
		});
		const archivedThread = objectValue(dataArray(responseResult(archived))[0]);
		const archivedUpdatedAt = Number(archivedThread.updatedAt);

		// When: the archived thread is unarchived without resuming its runtime.
		const unarchived = await registry.dispatch(connection, {
			id: 33,
			method: "thread/unarchive",
			params: { threadId },
		});

		// Then: the response is notLoaded with a bumped timestamp, and the runtime remains cold.
		const unarchivedThread = objectAt(responseResult(unarchived), "thread");
		expect(unarchivedThread.status).toEqual({ type: "notLoaded" });
		expect(unarchivedThread.updatedAt).toBeGreaterThan(archivedUpdatedAt);
		expect(() => threads.getLoadedThread(threadId)).toThrow();
		expect(connection.received).toEqual([]);
		const deferredUnarchive = deferredActions[0];
		if (!deferredUnarchive) {
			throw new Error("unarchive did not defer its broadcast");
		}
		const frames: unknown[] = [unarchived];
		await deferredUnarchive();
		frames.push(...connection.received);
		expect(frames[0]).toBe(unarchived);
		expect(frames[1]).toEqual({
			method: "thread/unarchived",
			params: { threadId },
			emittedAtMs: expect.any(Number),
		});
		expect(connection.received).toEqual([
			{ method: "thread/unarchived", params: { threadId }, emittedAtMs: expect.any(Number) },
		]);

		// And: an explicit resume is the operation that loads the runtime.
		const resumed = await registry.dispatch(connection, {
			id: 34,
			method: "thread/resume",
			params: { threadId },
		});
		expect(objectAt(responseResult(resumed), "thread").status).toEqual({ type: "idle" });

		// And: unknown and already-unarchived ids are invalid requests.
		await expect(
			registry.dispatch(connection, {
				id: 35,
				method: "thread/unarchive",
				params: { threadId: "66666666-6666-4666-8666-666666666666" },
			}),
		).resolves.toMatchObject({ id: 35, error: { code: -32600 } });
		await expect(
			registry.dispatch(connection, { id: 36, method: "thread/unarchive", params: { threadId } }),
		).resolves.toMatchObject({ id: 36, error: { code: -32600 } });
	});
});
