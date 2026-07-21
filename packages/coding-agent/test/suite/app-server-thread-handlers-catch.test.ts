import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { NotificationRouter } from "../../src/modes/app-server/server/notifications.ts";
import { registerThreadLifecycleHandlers } from "../../src/modes/app-server/threads/handlers.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import { cleanupRoots, createHarness } from "./app-server-thread-handlers-harness.ts";

describe("app-server thread lifecycle registry errors", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupRoots();
	});

	it("surfaces unexpected registry errors when unsubscribe checks loaded state", async () => {
		// Given: the loaded-thread lookup fails for an unexpected registry reason.
		const { connection, registry, threads } = await createHarness();
		threads.getLoadedThread = () => {
			throw new Error("synthetic registry failure");
		};

		// When: unsubscribe asks whether the thread is loaded.
		const response = await registry.dispatch(connection, {
			id: 23,
			method: "thread/unsubscribe",
			params: { threadId: "thread-1" },
		});

		// Then: JSON-RPC reports the unexpected registry error instead of a notLoaded state.
		expect(response).toEqual({
			id: 23,
			error: { code: -32603, message: "synthetic registry failure" },
		});
	});

	it("surfaces unexpected registry errors during idle unload", async () => {
		// Given: a subscribed thread whose idle unload lookup fails unexpectedly after unsubscribe.
		// Create the harness under real timers first; enable fake timers only for the countdown.
		const { connection, root, threads } = await createHarness();
		const entry = await threads.createThread({ cwd: root });
		const notifications = new NotificationRouter({ connections: [connection], threads: [entry] });
		const handlerRegistry = createRegistry();
		registerThreadLifecycleHandlers(handlerRegistry, {
			threads,
			turnLog: new TurnLog(),
			notifications,
			idleUnloadMinutes: 0,
		});
		notifications.subscribe(entry.id, connection.id);
		const originalGetLoadedThread = threads.getLoadedThread.bind(threads);
		let lookupCount = 0;
		threads.getLoadedThread = (threadId: string) => {
			lookupCount += 1;
			if (lookupCount === 1) {
				return originalGetLoadedThread(threadId);
			}
			throw new Error("synthetic idle unload failure");
		};

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		// When: unsubscribe schedules the idle unload timer.
		await expect(
			handlerRegistry.dispatch(connection, {
				id: 24,
				method: "thread/unsubscribe",
				params: { threadId: entry.id },
			}),
		).resolves.toEqual({ id: 24, result: { status: "unsubscribed" } });

		// Then: the idle timer reports the unexpected registry error instead of swallowing it.
		await expect(vi.advanceTimersByTimeAsync(0)).rejects.toThrow("synthetic idle unload failure");
	});
});
