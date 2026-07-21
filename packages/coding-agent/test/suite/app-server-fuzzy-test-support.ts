import type { FuzzyFileSearchResult } from "../../src/modes/app-server/protocol/fuzzy-search.ts";
import type { RpcRequest } from "../../src/modes/app-server/rpc/envelope.ts";
import type { RegistryConnection } from "../../src/modes/app-server/rpc/registry.ts";
import type { FuzzyFileEntry } from "../../src/modes/app-server/search/fuzzy-files.ts";
import type { FuzzyFileCollector, FuzzyFileRanker } from "../../src/modes/app-server/search/fuzzy-search-service.ts";
import type { RoutableConnection, RouterNotification } from "../../src/modes/app-server/server/notifications.ts";

export class FuzzyFakeConnection implements RoutableConnection {
	readonly transport = "stdio";
	readonly initialized = true;
	readonly id: string;
	readonly received: RouterNotification[] = [];
	readonly capabilities: { readonly experimentalApi: boolean };
	readonly completed: Promise<void>;
	private resolveCompleted: () => void = () => undefined;

	constructor(id: string, experimentalApi: boolean) {
		this.id = id;
		this.capabilities = { experimentalApi };
		this.completed = new Promise((resolve) => {
			this.resolveCompleted = resolve;
		});
	}

	send(notification: RouterNotification): void {
		this.received.push(notification);
		if (notification.method === "fuzzyFileSearch/sessionCompleted") this.resolveCompleted();
	}
}

export function initializedConnection(experimentalApi: boolean): RegistryConnection {
	return { initialized: true, capabilities: { experimentalApi } };
}

export function fuzzyRequest(id: number, method: string, params: unknown): RpcRequest {
	return { id, method, params };
}

export function deferredCollector(): {
	readonly collect: FuzzyFileCollector;
	readonly entered: Promise<void>;
	readonly finished: Promise<void>;
	readonly release: (entries: readonly FuzzyFileEntry[]) => void;
	readonly signal: AbortSignal | undefined;
} {
	let resolveEntered: () => void = () => undefined;
	let resolveFinished: () => void = () => undefined;
	let resolveEntries: (entries: readonly FuzzyFileEntry[]) => void = () => undefined;
	let currentSignal: AbortSignal | undefined;
	const entered = new Promise<void>((resolve) => {
		resolveEntered = resolve;
	});
	const finished = new Promise<void>((resolve) => {
		resolveFinished = resolve;
	});
	const entries = new Promise<readonly FuzzyFileEntry[]>((resolve) => {
		resolveEntries = resolve;
	});
	return {
		collect: async (_roots, signal) => {
			currentSignal = signal;
			resolveEntered();
			const result = await entries;
			resolveFinished();
			return result;
		},
		entered,
		finished,
		release: resolveEntries,
		get signal() {
			return currentSignal;
		},
	};
}

export function fixtureEntry(path: string): FuzzyFileEntry {
	return { root: "/fixture", path, matchType: "file", fileName: path };
}

export const fixtureRanker: FuzzyFileRanker = (query, entries) =>
	entries.map(
		(entry) =>
			({
				root: entry.root,
				path: entry.path,
				match_type: entry.matchType,
				file_name: entry.fileName,
				score: query.length,
				indices: query.length === 0 ? [] : [0],
			}) satisfies FuzzyFileSearchResult,
	);

export function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}
