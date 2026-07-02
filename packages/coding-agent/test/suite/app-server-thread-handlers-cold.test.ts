import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	scratchRoot,
	stringAt,
} from "./app-server-thread-handlers-harness.ts";

describe("app-server thread cold lifecycle handlers", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupRoots();
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
