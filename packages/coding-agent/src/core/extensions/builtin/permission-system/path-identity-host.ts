import { createMountRewrite, volumeKeyFor } from "./alias-detector.ts";
import type { MountSnapshot } from "./mount-table.ts";
import type { CanonicalPath, CanonicalRule } from "./path-identity.ts";
import {
	type BreakerState,
	createAbandonedWorkerCount,
	createBreakerRegistry,
	type ResolverStateEvent,
} from "./path-identity-breaker.ts";
import type { ResolverRequest, ResolverValue } from "./path-identity-protocol.ts";
import { createWorkerLifecycle } from "./path-identity-worker-lifecycle.ts";
import {
	ResolverFailure,
	type ResolverRequestOptions,
	ResolverTimeoutError,
	type ResolverTransport,
	ResolverUnavailableError,
	workerEntryFor,
	workerTransport,
} from "./path-identity-transport.ts";

export {
	BREAKER_BACKOFF_MAX_MS,
	BREAKER_BACKOFF_MS,
	type BreakerState,
	LEAK_GRACE_MS,
	MAX_LEAKED_WORKERS,
	type ResolverStateEvent,
} from "./path-identity-breaker.ts";
export { type ResolverRequestOptions, type ResolverTransport } from "./path-identity-transport.ts";

const DEFAULT_CHECK_DEADLINE_MS = 2000;
export const RULE_FILL_DEADLINE_MS = 250;

/** One derivation for the resolver deadline: three quarters of the slot deadline, capped at 1.5 s. */
export function resolverDeadlineMs(checkDeadlineMs: number = DEFAULT_CHECK_DEADLINE_MS): number {
	return Math.min(1500, Math.floor(checkDeadlineMs * 0.75));
}

export interface PathIdentityResolver {
	canonicalize(executed: string, cwd?: string, options?: ResolverRequestOptions): Promise<CanonicalPath>;
	canonicalizeRule(
		pattern: string,
		cwd?: string,
		options?: ResolverRequestOptions,
	): Promise<CanonicalRule | undefined>;
	/** True when an alias may be in play for the path; every error, timeout or budget miss answers true. */
	detect(path: string, options?: ResolverRequestOptions): Promise<boolean>;
	walk(path: string, options?: ResolverRequestOptions): Promise<string>;
	volumeKey(path: string): string;
	breakerState(key: string): BreakerState;
	onState(handler: (event: ResolverStateEvent) => void): () => void;
	/** How many state subscriptions are live; a retired service must not be among them. */
	readonly listenerCount: number;
	/** Spawn the worker now (it is otherwise started by the first request). */
	start(): void;
	/** Set once a worker failed to START (never from a stall): path rules then match by spelling only. */
	readonly unavailable: string | undefined;
	readonly leaked: number;
	readonly snapshot: MountSnapshot | undefined;
	close(): Promise<void>;
}

export interface ResolverHostOptions {
	readonly checkDeadlineMs?: number;
	readonly spawn?: () => ResolverTransport;
	/** The worker script the default transport starts; tests point it at a missing file. */
	readonly workerEntry?: string | URL;
	readonly onState?: (event: ResolverStateEvent) => void;
	readonly log?: (line: string) => void;
	/** Where a startup failure is reported, once; defaults to console.error. */
	readonly fatal?: (line: string) => void;
}

type RequestBody = ResolverRequest extends infer R ? (R extends ResolverRequest ? Omit<R, "id"> : never) : never;

interface Pending {
	readonly key: string;
	readonly soft: boolean;
	readonly resolve: (value: ResolverValue) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
}

export function createPathIdentityResolver(options: ResolverHostOptions = {}): PathIdentityResolver {
	const deadlineMs = resolverDeadlineMs(options.checkDeadlineMs);
	const spawn = options.spawn ?? (() => workerTransport(options.workerEntry ?? workerEntryFor(import.meta.url)));
	const log = options.log ?? ((line: string) => console.warn(`permission resolver: ${line}`));
	const fatal = options.fatal ?? ((line: string) => console.error(`permission resolver: ${line}`));
	const pending = new Map<number, Pending>();
	let snapshot: MountSnapshot | undefined;
	let rewrite = createMountRewrite([]);
	let nextId = 1;
	let closed = false;

	const listeners = new Set<(event: ResolverStateEvent) => void>();
	if (options.onState) listeners.add(options.onState);
	const emit = (volumeKey: string, state: ResolverStateEvent["state"]) => {
		log(`${volumeKey}: ${state} (leaked workers: ${abandoned.count})`);
		const event = { volumeKey, state, leaked: abandoned.count };
		for (const listener of listeners) listener(event);
	};
	const abandoned = createAbandonedWorkerCount(emit);
	const breakers = createBreakerRegistry(
		emit,
		() => abandoned.atCap,
		() => requestRefresh(),
	);

	const settle = (id: number): Pending | undefined => {
		const entry = pending.get(id);
		if (!entry) return undefined;
		pending.delete(id);
		clearTimeout(entry.timer);
		return entry;
	};

	const rejectAll = (detail: string) => {
		for (const [id, entry] of [...pending]) {
			pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(new ResolverTimeoutError(detail));
		}
	};

	const lifecycle = createWorkerLifecycle({
		spawn,
		abandoned,
		onSnapshot: (message) => {
			snapshot = message.snapshot;
			rewrite = createMountRewrite(message.firmlinks);
		},
		onReply: (message) => {
			const entry = settle(message.id);
			if (!entry) return;
			if (!entry.soft) breakers.recordSuccess(entry.key);
			if (message.ok) entry.resolve(message.value);
			else entry.reject(new ResolverFailure(message.code));
		},
		rejectAll,
		onUnavailable: (detail) => {
			breakers.clearProbes();
			for (const [id, entry] of [...pending]) {
				pending.delete(id);
				clearTimeout(entry.timer);
				entry.reject(new ResolverUnavailableError(detail));
			}
			fatal(`the path identity worker could not start (${detail}); path rules match by spelling only until restart`);
			emit("process", "unavailable");
		},
	});

	const requestRefresh = () => {
		lifecycle.live?.post({ id: nextId++, kind: "refresh" });
	};

	const send = (
		request: RequestBody,
		path: string,
		soft: boolean,
		onLate?: (value: ResolverValue) => void,
	): Promise<ResolverValue> => {
		if (closed) return Promise.reject(new ResolverTimeoutError("resolver closed"));
		if (lifecycle.unavailable !== undefined)
			return Promise.reject(new ResolverUnavailableError(lifecycle.unavailable));
		const transport = lifecycle.ensure();
		if (lifecycle.unavailable !== undefined)
			return Promise.reject(new ResolverUnavailableError(lifecycle.unavailable));
		const key = volumeKeyFor(snapshot, rewrite, path);
		const breaker = breakers.breakerFor(key);
		if (breaker.state === "open") return Promise.reject(new ResolverTimeoutError(`breaker open for ${key}`));
		if (!transport) return Promise.reject(new ResolverTimeoutError("leaked worker cap reached"));
		const id = nextId++;
		const budget = soft ? RULE_FILL_DEADLINE_MS : deadlineMs;
		return new Promise<ResolverValue>((resolve, reject) => {
			const timer = setTimeout(() => {
				const entry = settle(id);
				if (!entry) return;
				entry.reject(new ResolverTimeoutError(`${request.kind} ${path} after ${budget} ms`));
				if (entry.soft) {
					// The worker still computes it; a late answer is handed to onLate and never counts against anything.
					pending.set(id, { key, soft: true, resolve: onLate ?? (() => {}), reject: () => {}, timer: undefined });
					return;
				}
				breakers.recordTimeout(key);
				lifecycle.retire(`resolver stalled on ${key}`);
			}, budget);
			timer.unref?.();
			pending.set(id, { key, soft, resolve, reject, timer });
			transport.post({ ...request, id } as ResolverRequest);
		});
	};

	return {
		canonicalize: (executed, cwd, requestOptions) =>
			send(
				{ kind: "canonicalize", path: executed, cwd },
				executed,
				requestOptions?.soft ?? false,
				requestOptions?.onLate,
			) as Promise<CanonicalPath>,
		canonicalizeRule: (pattern, cwd, requestOptions) =>
			send(
				{ kind: "canonicalizeRule", pattern, cwd },
				pattern,
				requestOptions?.soft ?? false,
				requestOptions?.onLate,
			) as Promise<CanonicalRule | undefined>,
		detect: (path, requestOptions) =>
			send({ kind: "detect", path }, path, requestOptions?.soft ?? false, requestOptions?.onLate).then(
				(value) => value !== false,
				() => true,
			),
		walk: (path, requestOptions) =>
			send({ kind: "walk", path }, path, requestOptions?.soft ?? false, requestOptions?.onLate) as Promise<string>,
		start: () => {
			if (!closed) lifecycle.ensure();
		},
		get unavailable() {
			return lifecycle.unavailable;
		},
		volumeKey: (path) => volumeKeyFor(snapshot, rewrite, path),
		breakerState: (key) => breakers.stateOf(key),
		onState: (handler) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		get listenerCount() {
			return listeners.size;
		},
		get leaked() {
			return abandoned.count;
		},
		get snapshot() {
			return snapshot;
		},
		close: async () => {
			closed = true;
			breakers.clearProbes();
			const current = lifecycle.drop();
			rejectAll("resolver closed");
			if (current) await current.transport.terminate().catch(() => {});
		},
	};
}

let shared: PathIdentityResolver | undefined;

/** One worker per process serves every session (design 6.7). */
export function sharedPathIdentityResolver(): PathIdentityResolver {
	shared ??= createPathIdentityResolver();
	return shared;
}
