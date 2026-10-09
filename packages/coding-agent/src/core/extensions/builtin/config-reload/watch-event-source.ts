import { Worker } from "node:worker_threads";
import { watchWithErrorHandler } from "../../../../utils/fs-watch.ts";
import type { WatchEventListener, WatchEventSource } from "./watch-engine.ts";

export interface RecursiveWatchWorker {
	on(event: "message", listener: (message: unknown) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	postMessage(message: unknown): void;
	terminate(): Promise<number>;
}

export type RecursiveWatchWorkerFactory = () => RecursiveWatchWorker;

export type FsWatchEventSourceOptions = {
	readonly platform?: NodeJS.Platform;
	readonly createRecursiveWorker?: RecursiveWatchWorkerFactory;
};

type RecursiveWatchMessage =
	| { readonly kind: "event"; readonly id: number; readonly eventType: string; readonly filename: string | null }
	| { readonly kind: "error"; readonly id: number; readonly message: string };

const RECURSIVE_WATCH_WORKER_SOURCE = `
const { watch } = require("node:fs");
const { parentPort } = require("node:worker_threads");

if (!parentPort) throw new Error("Recursive watch worker requires a parent port");

const watchers = new Map();
const cancelled = new Set();
const isCancelled = (message) =>
	cancelled.has(message.id) || (message.active !== undefined && Atomics.load(message.active, 0) === 0);
parentPort.on("message", (message) => {
	if (message.kind === "unwatch") {
		cancelled.add(message.id);
		watchers.get(message.id)?.close();
		watchers.delete(message.id);
		return;
	}
	if (message.kind !== "watch") return;
	if (isCancelled(message)) return;
	try {
		const watcher = watch(
			message.path,
			{ recursive: message.recursive !== false, encoding: "utf8" },
			(eventType, filename) => {
				if (isCancelled(message)) return;
				parentPort.postMessage({
					kind: "event",
					id: message.id,
					eventType,
					filename: typeof filename === "string" ? filename : null,
				});
			},
		);
		if (isCancelled(message)) {
			watcher.close();
			return;
		}
		watcher.on("error", (error) => {
			parentPort.postMessage({
				kind: "error",
				id: message.id,
				message: error instanceof Error ? error.message : String(error),
			});
		});
		watchers.set(message.id, watcher);
	} catch (error) {
		parentPort.postMessage({
			kind: "error",
			id: message.id,
			message: error instanceof Error ? error.message : String(error),
		});
	}
});
`;

function createRecursiveWatchWorker(): RecursiveWatchWorker {
	return new Worker(RECURSIVE_WATCH_WORKER_SOURCE, {
		eval: true,
	});
}

/**
 * Per-subscription state for the shared recursive-watch worker. `onError` belongs to
 * the source that registered the subscription, so a shared worker fans message errors
 * and worker-death errors back to each subscriber's own handler.
 */
type RecursiveWatchSubscription = {
	readonly path: string;
	readonly listener: WatchEventListener;
	readonly recursive: boolean;
	readonly active: Int32Array;
	readonly onError: (error: unknown, path: string) => void;
};

/**
 * Process-wide worker state, keyed by the worker-factory identity. The default
 * factory maps to one entry, so every event source created without an injected
 * factory shares one worker; a test that injects its own fake gets an isolated
 * registry and never observes production state.
 */
type RecursiveWorkerState = {
	worker?: RecursiveWatchWorker;
	readonly subscriptions: Map<number, RecursiveWatchSubscription>;
	nextSubscriptionId: number;
};

const recursiveWorkerStates = new Map<RecursiveWatchWorkerFactory, RecursiveWorkerState>();

/**
 * Test seam: drops every shared worker registry. Termination is best-effort — a
 * worker that already failed to terminate must not keep a teardown sequence from
 * resetting the table. Returns the termination promises for callers that care.
 */
export function resetFsWatchWorkersForTests(): Array<Promise<number>> {
	const terminations: Array<Promise<number>> = [];
	for (const state of recursiveWorkerStates.values()) {
		if (state.worker) terminations.push(state.worker.terminate().catch(() => 0));
	}
	recursiveWorkerStates.clear();
	return terminations;
}

function isRecursiveWatchMessage(message: unknown): message is RecursiveWatchMessage {
	if (typeof message !== "object" || message === null || !("kind" in message)) return false;
	if (!("id" in message) || typeof message.id !== "number") return false;
	if (message.kind === "error") return "message" in message && typeof message.message === "string";
	return (
		message.kind === "event" &&
		"eventType" in message &&
		typeof message.eventType === "string" &&
		"filename" in message &&
		(message.filename === null || typeof message.filename === "string")
	);
}

/**
 * Platforms whose fs.watch handles are expensive to create and tear down on the
 * interactive main thread: inotify tree walks on Linux, FSEvents stream rendezvous on
 * macOS. Non-recursive per-directory watches pay the same FSEvents setup latency —
 * measured 2.7-8.0s per watch-engine target under system load — so every watch is
 * offloaded, not only recursive ones.
 */
const WORKER_OFFLOADED_WATCH_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux", "darwin"]);

/** Production event source. Watch setup and teardown run off the interactive main thread. */
export function createFsWatchEventSource(
	onError: (error: unknown, path: string) => void = () => {},
	options: FsWatchEventSourceOptions = {},
): WatchEventSource {
	const createWorker = options.createRecursiveWorker ?? createRecursiveWatchWorker;
	let state = recursiveWorkerStates.get(createWorker);
	if (!state) {
		state = { subscriptions: new Map(), nextSubscriptionId: 1 };
		recursiveWorkerStates.set(createWorker, state);
	}
	const recursiveSubscriptions = state.subscriptions;

	const ensureRecursiveWorker = (): RecursiveWatchWorker => {
		if (state.worker) return state.worker;
		const worker = createWorker();
		worker.on("message", (message) => {
			if (!isRecursiveWatchMessage(message)) return;
			const subscription = recursiveSubscriptions.get(message.id);
			if (!subscription) return;
			if (message.kind === "event") {
				subscription.listener(message.eventType, message.filename);
				return;
			}
			subscription.onError(new Error(message.message), subscription.path);
		});
		worker.on("error", (error) => {
			for (const subscription of recursiveSubscriptions.values()) subscription.onError(error, subscription.path);
			// A worker that raised an uncaught error is dead; keeping it would leave every
			// live subscription silent. Drop it and move the survivors to a fresh worker.
			if (state.worker !== worker) return;
			state.worker = undefined;
			if (recursiveSubscriptions.size === 0) return;
			const replacement = ensureRecursiveWorker();
			for (const [id, subscription] of recursiveSubscriptions) {
				replacement.postMessage({
					kind: "watch",
					id,
					path: subscription.path,
					recursive: subscription.recursive,
					active: subscription.active,
				});
			}
		});
		state.worker = worker;
		return worker;
	};

	return (path, listener, watchOptions) => {
		if (WORKER_OFFLOADED_WATCH_PLATFORMS.has(options.platform ?? process.platform)) {
			const id = state.nextSubscriptionId++;
			const recursive = watchOptions?.recursive ?? false;
			const active = new Int32Array(new SharedArrayBuffer(4));
			Atomics.store(active, 0, 1);
			ensureRecursiveWorker().postMessage({ kind: "watch", id, path, recursive, active });
			recursiveSubscriptions.set(id, { path, listener, recursive, active, onError });
			let closing: Promise<void> | undefined;
			return () => {
				if (!recursiveSubscriptions.delete(id)) return closing;
				Atomics.store(active, 0, 0);
				// Resolve at unsubscribe time: the worker may have been replaced after a crash.
				const worker = state.worker;
				if (!worker) return closing;
				worker.postMessage({ kind: "unwatch", id });
				if (recursiveSubscriptions.size > 0) return;
				state.worker = undefined;
				closing = worker.terminate().then(
					() => undefined,
					(error: unknown) => {
						onError(error, path);
						throw error;
					},
				);
				return closing;
			};
		}

		const watcher = watchWithErrorHandler(
			path,
			listener,
			() => onError(new Error(`fs.watch failed for ${path}`), path),
			{ recursive: watchOptions?.recursive ?? false },
		);
		return () => watcher?.close();
	};
}
