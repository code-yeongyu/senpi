import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
	createFsWatchEventSource,
	resetFsWatchWorkersForTests,
} from "../../src/core/extensions/builtin/config-reload/watch-event-source.ts";

class GatedWorker extends EventEmitter {
	readonly commands: unknown[] = [];
	readonly exit = Promise.withResolvers<number>();
	postMessage(command: unknown): void {
		this.commands.push(command);
	}
	terminate(): Promise<number> {
		return this.exit.promise;
	}
}

class CountingWorker extends EventEmitter {
	readonly commands: unknown[] = [];
	terminateCount = 0;
	readonly exit = Promise.withResolvers<number>();
	postMessage(command: unknown): void {
		this.commands.push(command);
	}
	terminate(): Promise<number> {
		this.terminateCount += 1;
		return this.exit.promise;
	}
}

// #1656: the worker source itself executes; only IPC delivery and native fs.watch are controlled.
describe("config watch worker shutdown", () => {
	it.each(["queued", "admitted"] as const)(
		"leaves no watcher when cancellation overtakes registration (%s)",
		async (phase) => {
			// Given: the production worker handler, paused before IPC delivery.
			const source = await readFile(
				new URL("../../src/core/extensions/builtin/config-reload/watch-event-source.ts", import.meta.url),
				"utf8",
			);
			const executable = source.match(/const RECURSIVE_WATCH_WORKER_SOURCE = `([\s\S]*?)`;/)?.[1];
			if (!executable) throw new Error("Worker entry source unavailable");
			const port = new EventEmitter();
			let registrations = 0;
			let cancel = () => {};
			runInNewContext(executable, {
				Atomics,
				require: (specifier: string) => {
					switch (specifier) {
						case "node:fs":
							return {
								watch: () => {
									if (phase === "admitted") cancel();
									registrations++;
									return Object.assign(new EventEmitter(), {
										close: () => {
											registrations--;
										},
									});
								},
							};
						case "node:worker_threads":
							return { parentPort: port };
						default:
							throw new Error(`Unexpected worker import: ${specifier}`);
					}
				},
			});
			const worker = new GatedWorker();
			const subscribe = createFsWatchEventSource(undefined, {
				platform: "darwin",
				createRecursiveWorker: () => worker,
			});
			const unsubscribe = subscribe("/queued-watch", () => {});
			cancel = () => {
				void unsubscribe();
			};
			try {
				// When: cancellation precedes dispatch or lands after admission inside fs.watch.
				// Snapshot IPC so an unwatch posted from inside fs.watch is not also delivered;
				// the post-watch cancellation check must dispose that handle itself.
				if (phase === "queued") cancel();
				const dispatched = worker.commands.splice(0);
				for (const command of dispatched) port.emit("message", command);
				worker.exit.resolve(0);
				await unsubscribe();
				// Then: late registration is immediately disposed, never retained for delivery.
				expect(registrations).toBe(0);
			} finally {
				worker.exit.resolve(0);
			}
		},
	);

	it("returns the native termination join on repeated final unsubscribe", async () => {
		// Given: termination cannot finish until the explicit release.
		const worker = new GatedWorker();
		const subscribe = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker: () => worker,
		});
		const unsubscribe = subscribe("/queued-watch", () => {});
		try {
			// When: the final unsubscribe is requested repeatedly.
			const first = unsubscribe();
			const second = unsubscribe();
			// Then: both callers own the same pending native teardown.
			expect(first).toBeInstanceOf(Promise);
			expect(second).toBe(first);
			worker.exit.resolve(0);
			await first;
		} finally {
			worker.exit.resolve(0);
		}
	});

	it("shares one worker between sources built from the same factory and terminates it only after the last unsubscribe", async () => {
		// Given: two event sources whose recursive-worker factory is one and the same.
		const workers: CountingWorker[] = [];
		const createRecursiveWorker = (): CountingWorker => {
			const worker = new CountingWorker();
			workers.push(worker);
			return worker;
		};
		const subscribeOne = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker,
		});
		const subscribeTwo = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker,
		});
		const unsubscribeOne = subscribeOne("/agent/extensions-one", () => {});
		const unsubscribeTwo = subscribeTwo("/agent/extensions-two", () => {});

		// When: the first source's last subscription goes away.
		const closingOne = unsubscribeOne();
		// Then: the surviving source keeps the one shared worker alive.
		expect(workers).toHaveLength(1);
		expect(workers[0]?.terminateCount).toBe(0);

		// When: the second source's last subscription goes away too.
		const closingTwo = unsubscribeTwo();
		// Then: the shared worker terminates, and no second worker was ever built.
		expect(workers).toHaveLength(1);
		expect(workers[0]?.terminateCount).toBe(1);
		workers[0]?.exit.resolve(0);
		await Promise.allSettled([closingOne, closingTwo]);
	});

	it("gives each worker factory its own shared worker", async () => {
		// Given: two distinct factories, one source per factory.
		const workersByFactory: [CountingWorker[], CountingWorker[]] = [[], []];
		const factoryFor = (index: 0 | 1): (() => CountingWorker) => {
			return () => {
				const worker = new CountingWorker();
				workersByFactory[index].push(worker);
				return worker;
			};
		};
		const subscribeOne = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker: factoryFor(0),
		});
		const subscribeTwo = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker: factoryFor(1),
		});
		const unsubscribeOne = subscribeOne("/agent/extensions-one", () => {});
		const unsubscribeTwo = subscribeTwo("/agent/extensions-two", () => {});
		expect(workersByFactory[0]).toHaveLength(1);
		expect(workersByFactory[1]).toHaveLength(1);

		// Draining one factory's subscriptions must not terminate the other factory's worker.
		const closingOne = unsubscribeOne();
		expect(workersByFactory[0][0]?.terminateCount).toBe(1);
		expect(workersByFactory[1][0]?.terminateCount).toBe(0);
		workersByFactory[0][0]?.exit.resolve(0);
		await closingOne;

		const closingTwo = unsubscribeTwo();
		expect(workersByFactory[1][0]?.terminateCount).toBe(1);
		workersByFactory[1][0]?.exit.resolve(0);
		await closingTwo;
	});

	it("resetFsWatchWorkersForTests terminates the live shared worker and clears the registry", async () => {
		// Given: one live shared worker behind a factory-keyed registry.
		const workers: CountingWorker[] = [];
		const createRecursiveWorker = (): CountingWorker => {
			const worker = new CountingWorker();
			workers.push(worker);
			return worker;
		};
		const subscribeOne = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker,
		});
		const unsubscribeOne = subscribeOne("/agent/extensions", () => {});
		expect(workers).toHaveLength(1);

		// When: the test seam drops all shared worker state.
		const terminations = resetFsWatchWorkersForTests();
		// Then: the live worker is terminated and the caller can join it.
		expect(workers[0]?.terminateCount).toBe(1);
		workers[0]?.exit.resolve(0);
		await Promise.all(terminations);

		// And: the same factory starts a fresh worker rather than reusing cleared state.
		const subscribeTwo = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker,
		});
		const unsubscribeTwo = subscribeTwo("/agent/extensions", () => {});
		expect(workers).toHaveLength(2);
		const closingTwo = unsubscribeTwo();
		workers[1]?.exit.resolve(0);
		await closingTwo;
		void unsubscribeOne;
	});
});
