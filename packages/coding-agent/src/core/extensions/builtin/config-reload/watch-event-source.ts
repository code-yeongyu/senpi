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
parentPort.on("message", (message) => {
	if (message.kind === "unwatch") {
		watchers.get(message.id)?.close();
		watchers.delete(message.id);
		return;
	}
	if (message.kind !== "watch") return;
	try {
		const watcher = watch(
			message.path,
			{ recursive: true, encoding: "utf8" },
			(eventType, filename) => {
				parentPort.postMessage({
					kind: "event",
					id: message.id,
					eventType,
					filename: typeof filename === "string" ? filename : null,
				});
			},
		);
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
 * Platforms whose recursive fs.watch handles are expensive to create and tear down on the
 * interactive main thread: inotify tree walks on Linux, FSEvents stream teardown on macOS.
 */
const WORKER_OFFLOADED_RECURSIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux", "darwin"]);

/** Production event source. Recursive setup and teardown run off the interactive main thread. */
export function createFsWatchEventSource(
	onError: (error: unknown, path: string) => void = () => {},
	options: FsWatchEventSourceOptions = {},
): WatchEventSource {
	const recursiveSubscriptions = new Map<number, { readonly path: string; readonly listener: WatchEventListener }>();
	let recursiveWorker: RecursiveWatchWorker | undefined;
	let nextSubscriptionId = 1;

	const ensureRecursiveWorker = (): RecursiveWatchWorker => {
		if (recursiveWorker) return recursiveWorker;
		const worker = (options.createRecursiveWorker ?? createRecursiveWatchWorker)();
		worker.on("message", (message) => {
			if (!isRecursiveWatchMessage(message)) return;
			const subscription = recursiveSubscriptions.get(message.id);
			if (!subscription) return;
			if (message.kind === "event") {
				subscription.listener(message.eventType, message.filename);
				return;
			}
			onError(new Error(message.message), subscription.path);
		});
		worker.on("error", (error) => {
			for (const subscription of recursiveSubscriptions.values()) onError(error, subscription.path);
		});
		recursiveWorker = worker;
		return worker;
	};

	return (path, listener, watchOptions) => {
		if (WORKER_OFFLOADED_RECURSIVE_PLATFORMS.has(options.platform ?? process.platform) && watchOptions?.recursive) {
			const id = nextSubscriptionId++;
			const worker = ensureRecursiveWorker();
			recursiveSubscriptions.set(id, { path, listener });
			worker.postMessage({ kind: "watch", id, path });
			return () => {
				if (!recursiveSubscriptions.delete(id)) return;
				if (recursiveSubscriptions.size > 0) {
					worker.postMessage({ kind: "unwatch", id });
					return;
				}
				recursiveWorker = undefined;
				void worker.terminate().catch((error: unknown) => onError(error, path));
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
