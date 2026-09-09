import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export { createFsWatchEventSource } from "./watch-event-source.ts";

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
	readonly allowedDirectories: Set<string>;
	/**
	 * Directories the scan actually descended into, which are exactly the
	 * directories worth handing to the OS. Recursive targets subscribe per entry
	 * here instead of registering their whole subtree.
	 */
	readonly watchedDirectories: Map<string, () => void>;
	/** Directories currently in scope, refreshed by every scan. */
	scannedDirectories: Set<string>;
};

type ResolvedWatchTarget = Omit<WatchTarget, "path"> & { readonly path: string };

type ScanResult = {
	readonly hashes: Map<string, string>;
	readonly allowedDirectories: Set<string>;
	/** Directories visited by the scan, i.e. the in-scope directory set. */
	readonly scannedDirectories: Set<string>;
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
				allowedDirectories: scan.allowedDirectories,
				watchedDirectories: new Map<string, () => void>(),
				scannedDirectories: scan.scannedDirectories,
			};
		});

		for (const state of this.#states) {
			this.#attach(state, state.scannedDirectories);
		}
	}

	/**
	 * Subscribes to exactly the in-scope directories.
	 *
	 * A `dir-recursive` target used to hand its root to `fs.watch({recursive:true})`,
	 * which registers the entire subtree with the OS watcher (FSEvents on macOS).
	 * The target `filter` only discards events after delivery, so an extensions or
	 * skills directory containing `node_modules` still cost a full-subtree
	 * registration per session. The scan already knows which directories are in
	 * scope — it skips `node_modules`, `.git`, symlinks, and filtered paths — so
	 * watching that set directly gives identical coverage at a fraction of the
	 * OS-level cost.
	 */
	#attach(state: TargetState, directories: ReadonlySet<string>): void {
		const recursive = state.target.kind === "dir-recursive";
		// The root is always watched so that creations directly beneath it are seen.
		const wanted = recursive ? new Set([state.target.path, ...directories]) : new Set([state.target.path]);
		for (const directory of wanted) {
			if (state.watchedDirectories.has(directory)) {
				continue;
			}
			try {
				const unsubscribe = this.#subscribe(
					directory,
					(eventType, filename) => {
						this.#onEvent(state, eventType, filename, directory);
					},
					{ recursive: false },
				);
				state.watchedDirectories.set(directory, unsubscribe);
				this.#unsubscribes.push(unsubscribe);
			} catch (error) {
				this.#reportError(error, directory);
			}
		}
	}

	/** Drops subscriptions for directories that left scope (deleted or filtered out). */
	#detachMissing(state: TargetState, live: ReadonlySet<string>): void {
		for (const [directory, unsubscribe] of [...state.watchedDirectories]) {
			if (directory === state.target.path || live.has(directory)) {
				continue;
			}
			state.watchedDirectories.delete(directory);
			const index = this.#unsubscribes.indexOf(unsubscribe);
			if (index >= 0) {
				this.#unsubscribes.splice(index, 1);
			}
			try {
				unsubscribe();
			} catch (error) {
				this.#reportError(error, directory);
			}
		}
	}

	/**
	 * Marks the engine inert synchronously, then drains the unsubscribe loop off
	 * the caller's stack. A single `fs.watch` unsubscribe can block for seconds on
	 * a loaded machine, and a reload awaits this call; every dispatch path already
	 * checks `#closed`, so the still-attached subscriptions are silent while the
	 * returned promise settles. Await it only to observe teardown completion.
	 */
	close(): Promise<void> {
		if (this.#closed) {
			return Promise.resolve();
		}
		this.#closed = true;
		if (this.#timer) {
			this.#clock.clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		const unsubscribes = this.#unsubscribes.splice(0);
		return new Promise<void>((settle) => {
			this.#clock.setTimeout(() => {
				for (const unsubscribe of unsubscribes) {
					try {
						unsubscribe();
					} catch (error) {
						this.#reportError(error, "watch subscription");
					}
				}
				settle();
			}, 0);
		});
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

	#onEvent(state: TargetState, _eventType: string, filename: string | null, watchedDirectory?: string): void {
		if (this.#closed) {
			return;
		}
		if (filename === null) {
			this.#pending.set(state, null);
		} else if (this.#pending.get(state) !== null) {
			const affected = this.#pending.get(state) ?? new Set<string>();
			// Per-directory subscriptions report names relative to their own directory,
			// so re-anchor them to the target root before matching.
			const relPath = normalizeRelativePath(
				watchedDirectory && watchedDirectory !== state.target.path
					? join(relative(state.target.path, watchedDirectory), filename)
					: filename,
			);
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
		const previousDirectories = new Set(state.allowedDirectories);
		const next = affected === null ? this.#scan(state.target) : this.#scanAffected(state.target, affected, state);

		if (affected === null) {
			state.hashes.clear();
			for (const [path, hash] of next.hashes) {
				state.hashes.set(path, hash);
			}
			state.allowedDirectories.clear();
			for (const path of next.allowedDirectories) {
				state.allowedDirectories.add(path);
			}
			state.scannedDirectories = next.scannedDirectories;
			this.#detachMissing(state, state.scannedDirectories);
			this.#attach(state, state.scannedDirectories);
			this.#compare(previousHashes, previousDirectories, state.hashes, state.allowedDirectories, changes);
			return;
		}

		const prefixes = [...affected].map((relPath) => join(state.target.path, relPath));
		for (const path of [...state.hashes.keys()]) {
			if (prefixes.some((prefix) => isWithin(path, prefix))) {
				state.hashes.delete(path);
			}
		}
		for (const path of [...state.allowedDirectories]) {
			if (prefixes.some((prefix) => isWithin(path, prefix))) {
				state.allowedDirectories.delete(path);
			}
		}
		for (const path of [...state.scannedDirectories]) {
			if (prefixes.some((prefix) => isWithin(path, prefix))) {
				state.scannedDirectories.delete(path);
			}
		}
		for (const [path, hash] of next.hashes) {
			state.hashes.set(path, hash);
		}
		for (const path of next.allowedDirectories) {
			state.allowedDirectories.add(path);
		}
		for (const path of next.scannedDirectories) {
			state.scannedDirectories.add(path);
		}
		// A partial rescan can both create and remove directories in scope, so the
		// subscription set is reconciled in both directions here too.
		this.#detachMissing(state, state.scannedDirectories);
		this.#attach(state, state.scannedDirectories);
		this.#compare(previousHashes, previousDirectories, state.hashes, state.allowedDirectories, changes);
	}

	#scanAffected(target: ResolvedWatchTarget, affected: Set<string>, state: TargetState): ScanResult {
		const result: ScanResult = { hashes: new Map(), allowedDirectories: new Set(), scannedDirectories: new Set() };
		for (const relPath of affected) {
			const absolutePath = join(target.path, relPath);
			this.#scanPath(target, absolutePath, relPath, result, state);
		}
		return result;
	}

	#scan(target: ResolvedWatchTarget): ScanResult {
		const result: ScanResult = { hashes: new Map(), allowedDirectories: new Set(), scannedDirectories: new Set() };
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
		const explicitlyAllowedDirectory = relPath !== "" && this.#isExplicitlyAllowedDirectory(target, relPath);
		if (explicitlyAllowedDirectory) {
			result.allowedDirectories.add(absolutePath);
		}
		if (relPath && target.kind === "dir") {
			return;
		}
		if (dotDirectory && !explicitlyAllowedDirectory) {
			return;
		}
		// Recorded before descending: this is the set the OS watcher subscribes to.
		result.scannedDirectories.add(absolutePath);
		try {
			for (const child of readdirSync(absolutePath, { withFileTypes: true })) {
				if (child.isSymbolicLink() || child.name === "node_modules" || child.name === ".git") {
					continue;
				}
				const childRelPath = relPath ? join(relPath, child.name) : child.name;
				if (
					child.isDirectory() &&
					child.name.startsWith(".") &&
					!this.#isExplicitlyAllowedDirectory(target, childRelPath)
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

	#isExplicitlyAllowedDirectory(target: ResolvedWatchTarget, relPath: string): boolean {
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
