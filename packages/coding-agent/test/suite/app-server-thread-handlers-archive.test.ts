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
});
