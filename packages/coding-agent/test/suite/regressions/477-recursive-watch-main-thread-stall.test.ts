import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFsWatchEventSource,
	type WatchEventListener,
} from "../../../src/core/extensions/builtin/config-reload/watch-engine.ts";

const mocks = vi.hoisted(() => ({ fsWatch: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, watch: mocks.fsWatch };
});

class WatcherProbe extends EventEmitter {
	readonly close = vi.fn();
}

class WorkerProbe extends EventEmitter {
	readonly postMessage = vi.fn();
	readonly terminate = vi.fn(async () => 0);
}

describe("issue #477 recursive watch main-thread stall", () => {
	beforeEach(() => {
		mocks.fsWatch.mockReset();
	});

	it("offloads Linux recursive watch setup instead of calling fs.watch on the main thread", () => {
		const worker = new WorkerProbe();
		const createRecursiveWorker = vi.fn(() => worker);
		const listener = vi.fn<WatchEventListener>();
		const source = createFsWatchEventSource(vi.fn(), {
			platform: "linux",
			createRecursiveWorker,
		});

		const unsubscribe = source("/large-workspace-mount", listener, { recursive: true });
		const unsubscribeSecond = source("/another-config-root", vi.fn(), { recursive: true });
		worker.emit("message", { kind: "event", id: 1, eventType: "change", filename: ".omo/omo.json" });

		expect(createRecursiveWorker).toHaveBeenCalledTimes(1);
		expect(worker.postMessage).toHaveBeenCalledWith({
			kind: "watch",
			id: 1,
			path: "/large-workspace-mount",
			recursive: true,
		});
		expect(worker.postMessage).toHaveBeenCalledWith({
			kind: "watch",
			id: 2,
			path: "/another-config-root",
			recursive: true,
		});
		expect(mocks.fsWatch).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledWith("change", ".omo/omo.json");

		unsubscribe();
		expect(worker.terminate).not.toHaveBeenCalled();
		unsubscribeSecond();
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("keeps non-recursive config file watches on direct fs.watch on non-offloaded platforms", () => {
		const watcher = new WatcherProbe();
		mocks.fsWatch.mockReturnValue(watcher);
		const createRecursiveWorker = vi.fn(() => new WorkerProbe());
		const source = createFsWatchEventSource(vi.fn(), {
			platform: "win32",
			createRecursiveWorker,
		});

		const unsubscribe = source("/small-config-directory", vi.fn(), { recursive: false });

		expect(mocks.fsWatch).toHaveBeenCalledWith(
			"/small-config-directory",
			expect.objectContaining({ recursive: false }),
			expect.any(Function),
		);
		expect(createRecursiveWorker).not.toHaveBeenCalled();

		unsubscribe();
		expect(watcher.close).toHaveBeenCalledTimes(1);
	});
});
