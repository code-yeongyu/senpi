import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { watchWithErrorHandler } from "../../../../utils/fs-watch.ts";

export type WatchTarget = {
	readonly id: string;
	readonly kind: "dir" | "dir-recursive";
	readonly path: string;
	readonly allowList?: readonly string[];
	readonly filter?: (relPath: string) => boolean;
};

export type WatchEventListener = (eventType: string, filename: string | null) => void;

export type WatchEventSource = (
	path: string,
	listener: WatchEventListener,
	options?: { readonly recursive: boolean },
) => () => void;

export type WatchClock = {
	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

export type RealChange = {
	readonly changedPaths: readonly string[];
	readonly created: readonly string[];
	readonly deleted: readonly string[];
};

export type ConfigReloadWatchEngineOptions = {
	readonly targets: readonly WatchTarget[];
	readonly subscribe: WatchEventSource;
	readonly onRealChange: (change: RealChange) => void;
	readonly onError?: (error: unknown, path: string) => void;
	readonly debounceMs?: number;
	readonly clock?: WatchClock;
	/** Test seam. Production callers use SHA-256 of file bytes. */
	readonly hashFile?: (path: string) => string;
};

type TargetState = {
	readonly target: ResolvedWatchTarget;
	readonly hashes: Map<string, string>;
	readonly allowedDotDirectories: Set<string>;
};

type ResolvedWatchTarget = Omit<WatchTarget, "path"> & { readonly path: string };

type ScanResult = {
	readonly hashes: Map<string, string>;
	readonly allowedDotDirectories: Set<string>;
};

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_CLOCK: WatchClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Hash-gates filesystem events. Targets are directories by design: watching a
 * file directly breaks when editors atomically rename a replacement over it.
 */
export class ConfigReloadWatchEngine {
	readonly #states: TargetState[];
	readonly #unsubscribes: (() => void)[] = [];
	readonly #subscribe: WatchEventSource;
	readonly #onRealChange: (change: RealChange) => void;
	readonly #onError: (error: unknown, path: string) => void;
	readonly #hashFile: (path: string) => string;
	readonly #clock: WatchClock;
	readonly #debounceMs: number;
	readonly #pending = new Map<TargetState, Set<string> | null>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	constructor(options: ConfigReloadWatchEngineOptions) {
		this.#subscribe = options.subscribe;
		this.#onRealChange = options.onRealChange;
		this.#onError = options.onError ?? (() => {});
		this.#hashFile = options.hashFile ?? hashFile;
		this.#clock = options.clock ?? DEFAULT_CLOCK;
		this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.#states = options.targets.map((target) => {
			const resolvedTarget = { ...target, path: resolve(target.path) };
			const scan = this.#scan(resolvedTarget);
			return {
				target: resolvedTarget,
				hashes: scan.hashes,
				allowedDotDirectories: scan.allowedDotDirectories,
			};
		});

		for (const state of this.#states) {
			try {
				this.#unsubscribes.push(
					this.#subscribe(
						state.target.path,
						(eventType, filename) => {
							this.#onEvent(state, eventType, filename);
						},
						{ recursive: state.target.kind === "dir-recursive" },
					),
				);
			} catch (error) {
				this.#reportError(error, state.target.path);
			}
		}
	}

	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		if (this.#timer) {
			this.#clock.clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		for (const unsubscribe of this.#unsubscribes.splice(0)) {
			try {
				unsubscribe();
			} catch (error) {
				this.#reportError(error, "watch subscription");
			}
		}
	}

	getBaselineSnapshot(): ReadonlyMap<string, string> {
		const snapshot = new Map<string, string>();
		for (const state of this.#states) {
			for (const [path, hash] of state.hashes) {
				snapshot.set(path, hash);
			}
		}
		return snapshot;
	}

	#onEvent(state: TargetState, _eventType: string, filename: string | null): void {
		if (this.#closed) {
			return;
		}
		if (filename === null) {
			this.#pending.set(state, null);
		} else if (this.#pending.get(state) !== null) {
			const affected = this.#pending.get(state) ?? new Set<string>();
			const relPath = normalizeRelativePath(filename);
			if (relPath && this.#matches(state.target, relPath)) {
				affected.add(relPath);
				this.#pending.set(state, affected);
			}
		}
		this.#schedule();
	}

	#schedule(): void {
		if (this.#timer) {
			this.#clock.clearTimeout(this.#timer);
		}
		this.#timer = this.#clock.setTimeout(() => {
			this.#timer = undefined;
			this.#evaluatePending();
		}, this.#debounceMs);
	}

	#evaluatePending(): void {
		if (this.#closed) {
			return;
		}
		const changes = new Map<string, { created: boolean; deleted: boolean }>();
		for (const [state, affected] of this.#pending) {
			this.#evaluateState(state, affected, changes);
		}
		this.#pending.clear();
		if (changes.size > 0) {
			const changedPaths = [...changes.keys()].sort();
			this.#onRealChange({
				changedPaths,
				created: changedPaths.filter((path) => changes.get(path)?.created),
				deleted: changedPaths.filter((path) => changes.get(path)?.deleted),
			});
		}
	}

	#evaluateState(
		state: TargetState,
		affected: Set<string> | null,
		changes: Map<string, { created: boolean; deleted: boolean }>,
	): void {
		const previousHashes = new Map(state.hashes);
		const previousDirectories = new Set(state.allowedDotDirectories);
		const next = affected === null ? this.#scan(state.target) : this.#scanAffected(state.target, affected, state);

		if (affected === null) {
			state.hashes.clear();
			for (const [path, hash] of next.hashes) {
				state.hashes.set(path, hash);
			}
			state.allowedDotDirectories.clear();
			for (const path of next.allowedDotDirectories) {
				state.allowedDotDirectories.add(path);
			}
			this.#compare(previousHashes, previousDirectories, state.hashes, state.allowedDotDirectories, changes);
			return;
		}

		const prefixes = [...affected].map((relPath) => join(state.target.path, relPath));
		for (const path of [...state.hashes.keys()]) {
			if (prefixes.some((prefix) => isWithin(path, prefix))) {
				state.hashes.delete(path);
			}
		}
		for (const path of [...state.allowedDotDirectories]) {
			if (prefixes.some((prefix) => isWithin(path, prefix))) {
				state.allowedDotDirectories.delete(path);
			}
		}
		for (const [path, hash] of next.hashes) {
			state.hashes.set(path, hash);
		}
		for (const path of next.allowedDotDirectories) {
			state.allowedDotDirectories.add(path);
		}
		this.#compare(previousHashes, previousDirectories, state.hashes, state.allowedDotDirectories, changes);
	}

	#scanAffected(target: ResolvedWatchTarget, affected: Set<string>, state: TargetState): ScanResult {
		const result: ScanResult = { hashes: new Map(), allowedDotDirectories: new Set() };
		for (const relPath of affected) {
			const absolutePath = join(target.path, relPath);
			this.#scanPath(target, absolutePath, relPath, result, state);
		}
		return result;
	}

	#scan(target: ResolvedWatchTarget): ScanResult {
		const result: ScanResult = { hashes: new Map(), allowedDotDirectories: new Set() };
		this.#scanPath(target, target.path, "", result);
		return result;
	}

	#scanPath(
		target: ResolvedWatchTarget,
		absolutePath: string,
		relPath: string,
		result: ScanResult,
		state?: TargetState,
	): void {
		if (relPath && !this.#matches(target, relPath)) {
			return;
		}
		let entry: Stats;
		try {
			entry = lstatSync(absolutePath);
		} catch (error) {
			if (state && !isMissing(error)) {
				this.#reportError(error, absolutePath);
			}
			return;
		}
		if (entry.isSymbolicLink()) {
			return;
		}
		if (entry.isFile()) {
			try {
				result.hashes.set(absolutePath, this.#hashFile(absolutePath));
			} catch (error) {
				this.#reportError(error, absolutePath);
			}
			return;
		}
		if (!entry.isDirectory()) {
			return;
		}

		const dotDirectory = relPath !== "" && basename(relPath).startsWith(".");
		const allowedDotDirectory = dotDirectory && this.#isExplicitlyAllowedDotDirectory(target, relPath);
		if (allowedDotDirectory) {
			result.allowedDotDirectories.add(absolutePath);
		}
		if (relPath && target.kind === "dir") {
			return;
		}
		if (dotDirectory && !allowedDotDirectory) {
			return;
		}
		try {
			for (const child of readdirSync(absolutePath, { withFileTypes: true })) {
				if (child.isSymbolicLink() || child.name === "node_modules" || child.name === ".git") {
					continue;
				}
				const childRelPath = relPath ? join(relPath, child.name) : child.name;
				if (
					child.isDirectory() &&
					child.name.startsWith(".") &&
					!this.#isExplicitlyAllowedDotDirectory(target, childRelPath)
				) {
					continue;
				}
				this.#scanPath(target, join(absolutePath, child.name), childRelPath, result, state);
			}
		} catch (error) {
			this.#reportError(error, absolutePath);
		}
	}

	#compare(
		previousHashes: ReadonlyMap<string, string>,
		previousDirectories: ReadonlySet<string>,
		nextHashes: ReadonlyMap<string, string>,
		nextDirectories: ReadonlySet<string>,
		changes: Map<string, { created: boolean; deleted: boolean }>,
	): void {
		for (const [path, hash] of nextHashes) {
			const oldHash = previousHashes.get(path);
			if (oldHash !== hash) {
				changes.set(path, { created: oldHash === undefined, deleted: false });
			}
		}
		for (const path of previousHashes.keys()) {
			if (!nextHashes.has(path)) {
				changes.set(path, { created: false, deleted: true });
			}
		}
		for (const path of nextDirectories) {
			if (!previousDirectories.has(path)) {
				changes.set(path, { created: true, deleted: false });
			}
		}
		for (const path of previousDirectories) {
			if (!nextDirectories.has(path)) {
				changes.set(path, { created: false, deleted: true });
			}
		}
	}

	#matches(target: ResolvedWatchTarget, relPath: string): boolean {
		if (!target.kind.includes("recursive") && relPath.includes(sep)) {
			return false;
		}
		if (
			target.allowList &&
			!target.allowList.some((allowed) => relPath === allowed || relPath.startsWith(`${allowed}${sep}`))
		) {
			return false;
		}
		return target.filter?.(relPath) ?? true;
	}

	#isExplicitlyAllowedDotDirectory(target: ResolvedWatchTarget, relPath: string): boolean {
		return (
			target.allowList?.some((allowed) => relPath === allowed || relPath.startsWith(`${allowed}${sep}`)) ?? false
		);
	}

	#reportError(error: unknown, path: string): void {
		try {
			this.#onError(error, path);
		} catch {
			// Error reporting must not take down the watcher.
		}
	}
}

/** Production event source. Tests inject a deterministic source instead. */
export function createFsWatchEventSource(onError: (error: unknown, path: string) => void = () => {}): WatchEventSource {
	return (path, listener, options) => {
		const watcher = watchWithErrorHandler(
			path,
			listener,
			() => onError(new Error(`fs.watch failed for ${path}`), path),
			{ recursive: options?.recursive ?? false },
		);
		return () => watcher?.close();
	};
}

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeRelativePath(filename: string): string | undefined {
	if (isAbsolute(filename)) {
		return undefined;
	}
	const normalized = normalize(filename);
	return normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`) ? undefined : normalized;
}

function isWithin(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}${sep}`);
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
