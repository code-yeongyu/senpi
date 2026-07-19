import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import {
	cleanupRoots,
	createHarness,
	objectValue,
	responseResult,
	stringAt,
} from "./app-server-thread-handlers-harness.ts";

afterEach(async () => {
	await cleanupRoots();
});

describe("app-server thread/compact/start", () => {
	it("acknowledges before compaction completes and emits context-compaction items only", async () => {
		// Given: a loaded thread whose compaction is held open by the scripted session.
		const { connection, registry, root, threads } = await createHarness();
		const started = await registry.dispatch(connection, { id: 1, method: "thread/start", params: { cwd: root } });
		const threadId = stringAt(responseResult(started).thread, "id");
		const entry = threads.getLoadedThread(threadId);
		const deferred = createDeferred<CompactionResult>();
		const compact = vi.spyOn(entry.session, "compact").mockReturnValue(deferred.promise);
		connection.received.length = 0;

		// When: compaction is requested while the session promise remains pending.
		const response = await registry.dispatch(connection, {
			id: 2,
			method: "thread/compact/start",
			params: { threadId },
		});

		// Then: the request is acknowledged immediately and the started item is visible first.
		expect(response).toEqual({ id: 2, result: {} });
		expect(compact).toHaveBeenCalledOnce();
		expect(connection.received).toHaveLength(1);
		expect(connection.received[0]).toMatchObject({
			method: "item/started",
			params: { threadId, item: { type: "contextCompaction" } },
		});
		expect(connection.received.some((notification) => notification.method === "thread/compacted")).toBe(false);

		// When: the scripted compaction completes.
		deferred.resolve({ summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 10 });
		await deferred.promise;
		await Promise.resolve();

		// Then: completion uses the same context-compaction item and never emits the deprecated notification.
		expect(connection.received).toHaveLength(2);
		expect(connection.received[1]).toMatchObject({
			method: "item/completed",
			params: { threadId, item: { type: "contextCompaction" } },
		});
		const startedParams = objectValue(connection.received[0]?.params);
		const completedParams = objectValue(connection.received[1]?.params);
		const startedItem = objectValue(startedParams.item);
		const completedItem = objectValue(completedParams.item);
		expect(completedParams.turnId).toBe(startedParams.turnId);
		expect(completedItem.id).toBe(startedItem.id);
		expect(connection.received.some((notification) => notification.method === "thread/compacted")).toBe(false);
	});

	it("rejects unknown and unloaded threads as invalid requests", async () => {
		// Given: an unknown id and a known thread that has been unloaded.
		const { connection, registry, root, threads } = await createHarness();
		const started = await registry.dispatch(connection, { id: 3, method: "thread/start", params: { cwd: root } });
		const threadId = stringAt(responseResult(started).thread, "id");
		threads.unloadThread(threadId);

		// When: compaction is requested for each unavailable thread.
		const unloaded = await registry.dispatch(connection, {
			id: 4,
			method: "thread/compact/start",
			params: { threadId },
		});
		const unknown = await registry.dispatch(connection, {
			id: 5,
			method: "thread/compact/start",
			params: { threadId: "missing-thread" },
		});

		// Then: both failures use the invalid-request category and identify the missing thread.
		expect(unloaded).toMatchObject({
			id: 4,
			error: { code: -32600, message: expect.stringContaining("thread not found") },
		});
		expect(unknown).toMatchObject({
			id: 5,
			error: { code: -32600, message: expect.stringContaining("thread not found") },
		});
	});
});

function createDeferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) throw new Error("deferred resolver was not initialized");
	return { promise, resolve: resolvePromise };
}
