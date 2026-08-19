import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEntry } from "../../src/modes/app-server/threads/registry.ts";
import type { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	cleanupRoots,
	createHarness,
	createHarnessForRoot,
	dataArray,
	objectAt,
	responseResult,
	writePersistedSession,
} from "./app-server-thread-handlers-harness.ts";

afterEach(async () => {
	await cleanupRoots();
});

describe("app-server thread/rollback", () => {
	it("drops the requested wire turns while retaining abandoned session entries", async () => {
		// Given: a loaded thread with two completed turns and persisted pre-turn leaf checkpoints.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		recordCompletedTurn(entry, turnLog, "turn-1");
		recordCompletedTurn(entry, turnLog, "turn-2");
		const retainedEntryIds = entry.session.sessionManager.getEntries().map((sessionEntry) => sessionEntry.id);

		// When: the client rolls back the latest turn.
		const response = await registry.dispatch(connection, {
			id: 1,
			method: "thread/rollback",
			params: { threadId: entry.id, numTurns: 1 },
		});

		// Then: only one wire turn remains and every abandoned session entry is retained.
		expect(dataArray(objectAt(responseResult(response), "thread"), "turns")).toHaveLength(1);
		expect(entry.session.sessionManager.getEntries().map((sessionEntry) => sessionEntry.id)).toEqual(
			expect.arrayContaining(retainedEntryIds),
		);
	});

	it("persists the selected leaf across unload and resume", async () => {
		// Given: a two-turn thread rolled back to the first turn.
		const { connection, registry, root, threads, turnLog } = await createHarness();
		const threadId = "56565656-5656-4656-8656-565656565656";
		await writePersistedSession(root, threadId);
		const entry = await threads.resumeThread(threadId);
		const retainedTurnEntryId = recordCompletedTurn(entry, turnLog, "turn-1");
		const abandonedTurnEntryId = recordCompletedTurn(entry, turnLog, "turn-2");
		await registry.dispatch(connection, {
			id: 2,
			method: "thread/rollback",
			params: { threadId: entry.id, numTurns: 1 },
		});
		expect(threads.unloadThread(entry.id)).toBe(true);

		// When: a fresh registry with an empty TurnLog resumes the persisted thread.
		const restarted = createHarnessForRoot(root);
		const response = await restarted.registry.dispatch(restarted.connection, {
			id: 3,
			method: "thread/resume",
			params: { threadId: entry.id },
		});

		// Then: the resumed snapshot and persisted branch both reflect the selected cutoff.
		expect(dataArray(objectAt(responseResult(response), "thread"), "turns")).toHaveLength(1);
		const resumedBranchIds = restarted.threads
			.getLoadedThread(entry.id)
			.session.sessionManager.getBranch()
			.map((sessionEntry) => sessionEntry.id);
		expect(resumedBranchIds).toContain(retainedTurnEntryId);
		expect(resumedBranchIds).not.toContain(abandonedTurnEntryId);
	});

	it("returns an RPC error when the thread does not exist", async () => {
		// Given: a registry without the requested thread.
		const { connection, registry } = await createHarness();

		// When: rollback targets an unknown thread id.
		const response = await registry.dispatch(connection, {
			id: 4,
			method: "thread/rollback",
			params: { threadId: "missing-thread", numTurns: 1 },
		});

		// Then: dispatch returns a scoped RPC error instead of crashing.
		expect(response).toMatchObject({
			id: 4,
			error: { code: -32600, message: expect.stringContaining("thread not found") },
		});
	});

	it("returns an RPC error when a turn is active", async () => {
		// Given: a loaded thread with an active turn.
		const { connection, registry, root, threads } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		entry.activeTurn = { turnId: "active-turn", startedAt: "2026-08-19T00:00:00.000Z" };

		// When: rollback targets the active thread.
		const response = await registry.dispatch(connection, {
			id: 5,
			method: "thread/rollback",
			params: { threadId: entry.id, numTurns: 1 },
		});

		// Then: dispatch rejects the mutation with an RPC error.
		expect(response).toMatchObject({
			id: 5,
			error: { code: -32600, message: expect.stringContaining("active turn") },
		});
	});

	it("returns an RPC error when threadId is missing", async () => {
		// Given: a valid rollback count without a thread identifier.
		const { connection, registry } = await createHarness();

		// When: rollback receives malformed params.
		const response = await registry.dispatch(connection, {
			id: 6,
			method: "thread/rollback",
			params: { numTurns: 1 },
		});

		// Then: dispatch returns an invalid-params RPC error.
		expect(response).toMatchObject({ id: 6, error: { code: -32600 } });
	});

	it("returns an RPC error when numTurns is not a positive integer", async () => {
		// Given: an existing idle thread.
		const { connection, registry, root, threads } = await createHarness();
		const entry = await threads.createThread({ cwd: root });

		// When: rollback receives an invalid turn count.
		const response = await registry.dispatch(connection, {
			id: 7,
			method: "thread/rollback",
			params: { threadId: entry.id, numTurns: 0 },
		});

		// Then: dispatch returns an invalid-params RPC error.
		expect(response).toMatchObject({ id: 7, error: { code: -32600 } });
	});
});

function recordCompletedTurn(entry: ThreadEntry, turnLog: TurnLog, turnId: string): string {
	const rollbackLeafId = entry.session.sessionManager.getLeafId();
	const sessionEntryId = entry.session.sessionManager.appendMessage({
		role: "user",
		content: turnId,
		timestamp: Date.parse("2026-08-19T00:00:00.000Z"),
	});
	turnLog.recordTurn(entry.id, {
		turnId,
		startedAt: "2026-08-19T00:00:00.000Z",
		status: "completed",
		rollbackLeafId,
	});
	return sessionEntryId;
}
