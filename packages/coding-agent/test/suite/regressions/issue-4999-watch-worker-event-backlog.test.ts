import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
	createFsWatchEventSource,
	type WatchEventListener,
} from "../../../src/core/extensions/builtin/config-reload/watch-engine.ts";

type WatchCallback = (eventType: string, filename: string | null) => void;

/**
 * The production watch-worker source, executed against a fake parent port and a fake
 * fs.watch: the test fires native events by hand and reads exactly what the worker
 * would have queued for the main thread (senpi#4999).
 */
async function startWorkerSource(): Promise<{
	posted: unknown[];
	send: (message: unknown) => void;
	fire: WatchCallback;
}> {
	const source = await readFile(
		new URL("../../../src/core/extensions/builtin/config-reload/watch-event-source.ts", import.meta.url),
		"utf8",
	);
	const executable = source.match(/const RECURSIVE_WATCH_WORKER_SOURCE = `([\s\S]*?)`;/)?.[1];
	if (!executable) throw new Error("Worker entry source unavailable");
	const posted: unknown[] = [];
	const port = Object.assign(new EventEmitter(), {
		postMessage: (message: unknown) => {
			posted.push(message);
		},
	});
	let callback: WatchCallback | undefined;
	runInNewContext(executable, {
		Atomics,
		require: (specifier: string) => {
			switch (specifier) {
				case "node:fs":
					return {
						watch: (_path: string, _options: unknown, listener: WatchCallback) => {
							callback = listener;
							return Object.assign(new EventEmitter(), { close: () => {} });
						},
					};
				case "node:worker_threads":
					return { parentPort: port };
				default:
					throw new Error(`Unexpected worker import: ${specifier}`);
			}
		},
	});
	const active = new Int32Array(new SharedArrayBuffer(4));
	Atomics.store(active, 0, 1);
	port.emit("message", { kind: "watch", id: 1, path: "/agent", recursive: false, active });
	if (!callback) throw new Error("worker did not register a watcher");
	const fire = callback;
	return { posted, send: (message) => port.emit("message", message), fire };
}

function deliveredEvents(posted: readonly unknown[]): Array<{ eventType: string; filename: string | null }> {
	const events: Array<{ eventType: string; filename: string | null }> = [];
	for (const message of posted) {
		const record = message as { kind?: string; events?: unknown; eventType?: string; filename?: string | null };
		if (record.kind === "event" && typeof record.eventType === "string")
			events.push({ eventType: record.eventType, filename: record.filename ?? null });
		if (record.kind === "events" && Array.isArray(record.events))
			events.push(...(record.events as Array<{ eventType: string; filename: string | null }>));
	}
	return events;
}

describe("issue 4999: the watch worker never queues more than the main thread has taken", () => {
	it("a burst of native events on one file queues one message until the main thread acknowledges it", async () => {
		// Given: a watched directory whose lock file is rewritten thousands of times while the
		// main thread is busy (a 20-session host rewrites hooks-state.json.lock on every hook status).
		const worker = await startWorkerSource();

		// When: 4,000 native events arrive before the main thread has handled any message.
		for (let index = 0; index < 2_000; index++) {
			worker.fire("rename", "hooks-state.json.lock");
			worker.fire("change", "hooks-state.json.lock");
		}

		// Then: at most one message is waiting for the main thread, not one per native event.
		expect(worker.posted).toHaveLength(1);

		// When: the main thread takes that message and acknowledges it.
		worker.send({ kind: "ack", id: 1 });

		// Then: everything that arrived meanwhile follows as one message, each distinct event once.
		expect(worker.posted).toHaveLength(2);
		expect(deliveredEvents(worker.posted)).toEqual([
			{ eventType: "rename", filename: "hooks-state.json.lock" },
			{ eventType: "change", filename: "hooks-state.json.lock" },
			{ eventType: "rename", filename: "hooks-state.json.lock" },
		]);

		// And: once nothing is pending, the next event goes out at once.
		worker.send({ kind: "ack", id: 1 });
		expect(worker.posted).toHaveLength(2);
		worker.fire("change", "settings.json");
		expect(worker.posted).toHaveLength(3);
		expect(deliveredEvents(worker.posted).at(-1)).toEqual({ eventType: "change", filename: "settings.json" });
	});

	it("collapses an unbounded set of distinct names into one rescan event", async () => {
		// Given: a burst that names more distinct files than the worker keeps.
		const worker = await startWorkerSource();
		worker.fire("change", "first.json");
		for (let index = 0; index < 5_000; index++) worker.fire("rename", `session-${index}.tmp`);

		// When: the main thread acknowledges the first message.
		worker.send({ kind: "ack", id: 1 });

		// Then: the backlog arrives as a single name-less event, which the engine answers with a full rescan.
		expect(worker.posted).toHaveLength(2);
		expect(deliveredEvents(worker.posted)).toEqual([
			{ eventType: "change", filename: "first.json" },
			{ eventType: "rename", filename: null },
		]);
	});

	it("the main thread hands each batched event to the listener and acknowledges the batch", () => {
		// Given: a subscription on the shared worker.
		const worker = Object.assign(new EventEmitter(), {
			commands: [] as unknown[],
			postMessage(command: unknown) {
				this.commands.push(command);
			},
			terminate: async () => 0,
		});
		const calls: Array<[string, string | null]> = [];
		const listener: WatchEventListener = (eventType, filename) => {
			calls.push([eventType, filename]);
		};
		const subscribe = createFsWatchEventSource(undefined, { platform: "linux", createRecursiveWorker: () => worker });
		const unsubscribe = subscribe("/agent", listener, { recursive: false });

		// When: the worker delivers one batch.
		worker.emit("message", {
			kind: "events",
			id: 1,
			events: [
				{ eventType: "rename", filename: "hooks-state.json.lock" },
				{ eventType: "change", filename: "settings.json" },
			],
		});

		// Then: the listener sees every event, and the worker is told it may send the next batch.
		expect(calls).toEqual([
			["rename", "hooks-state.json.lock"],
			["change", "settings.json"],
		]);
		expect(worker.commands.at(-1)).toEqual({ kind: "ack", id: 1 });
		void unsubscribe();
	});
});
