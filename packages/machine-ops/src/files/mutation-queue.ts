import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";
import {
	foldPathForCaseInsensitiveFilesystem,
	isMissingPathError,
	RESOLUTION_TIMED_OUT,
	withResolutionDeadline,
} from "./bounded-realpath.ts";
import { realpathWithoutOpenStrict } from "./realpath-without-open.ts";

/**
 * Every spelling of one file must produce one key, or two mutations of that file run concurrently
 * and the later write silently discards the earlier one. `realpath` supplies that identity,
 * including the on-disk case of an alias such as `Notes.txt` vs `notes.txt`; a path that does not
 * exist yet keys on its resolved form. On a wedged mount `realpath` never returns, so the
 * resolution is bounded and falls back to the open(2)-free walker, and the key is case-folded on
 * filesystems that ignore case so the fallback and the fast path agree on the same file.
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	const canonicalPath = await withResolutionDeadline(realpath(resolvedPath)).catch((error: unknown) => {
		if (isMissingPathError(error)) return resolvedPath;
		throw error;
	});
	const identity = canonicalPath === RESOLUTION_TIMED_OUT ? realpathWithoutOpenStrict(resolvedPath) : canonicalPath;
	return foldPathForCaseInsensitiveFilesystem(identity);
}

/**
 * A file whose slot is held by a module that is stuck (past its deadline and grace, still running in this process where
 * nothing can stop it). The slot stays held - releasing it could let a second writer interleave with a write still in
 * flight - so every waiter fails with this instead of waiting forever. Another copy of this module in the same realm
 * may have built the error, so callers that must work across copies read `code`, never the class.
 */
export class FileLockedByStuckModuleError extends Error {
	readonly code = "file_locked_by_stuck_module";
	readonly path: string;
	readonly holder: string;
	constructor(path: string, holder: string) {
		super(
			`file_locked_by_stuck_module: ${path} is locked by ${holder}, which is stuck past its deadline; it is released when that module finishes or the session is closed`,
		);
		this.name = "FileLockedByStuckModuleError";
		this.path = path;
		this.holder = holder;
	}
}

/** The holder's side of a slot: release it, or mark its holder stuck (the slot stays held; every waiter fails fast). */
export interface FileMutationLock {
	(): void;
	markStuck(holder: string): void;
}

/** What the queue knows about stuck holders and the waiters that would fail with them, for diagnostics. */
interface StuckSnapshot {
	readonly holders: readonly { readonly path: string; readonly holder: string }[];
	readonly waiters: number;
}

/**
 * The file-mutation queue of every engine copy in this realm (omo#12965). Edit, write, patch and the remote hand's file
 * operations of any copy must queue behind one another per file: with a queue per copy, two mutations of one file run
 * concurrently and the later write discards the earlier one. The queues, the registration order and the stuck-holder
 * state live only in the closure of the copy that created the registry; every copy calls through these members.
 */
interface FileMutationQueue {
	acquire(filePath: string, signal?: AbortSignal): Promise<FileMutationLock>;
	withQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
	withQueues<T>(filePaths: readonly string[], fn: () => Promise<T>): Promise<T>;
	stuck(): StuckSnapshot;
}

interface QueueSlot {
	readonly key: string;
	readonly currentQueue: Promise<void>;
	readonly release: () => void;
}

function createFileMutationQueue(): FileMutationQueue {
	const fileMutationQueues = new Map<string, Promise<void>>();
	let registrationQueue = Promise.resolve();
	/** Keys whose holder is stuck, and the waiters to fail when a holder becomes stuck. */
	const stuckHolders = new Map<string, FileLockedByStuckModuleError>();
	const stuckWaiters = new Map<string, Set<(error: FileLockedByStuckModuleError) => void>>();

	const registerSlot = (filePath: string): Promise<QueueSlot> => {
		const registration = registrationQueue.then(async () => {
			const key = await getMutationQueueKey(filePath);
			const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

			let releaseNext!: () => void;
			const nextQueue = new Promise<void>((resolveQueue) => {
				releaseNext = resolveQueue;
			});
			const chainedQueue = currentQueue.then(() => nextQueue);
			fileMutationQueues.set(key, chainedQueue);

			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				releaseNext();
				if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
			};
			return { key, currentQueue, release };
		});
		registrationQueue = registration.then(
			() => undefined,
			() => undefined,
		);
		return registration;
	};

	/**
	 * Waits for the slot's turn; a waiter whose `signal` aborts, or whose file's holder is (or becomes) stuck, rejects
	 * without ever holding the slot, and the slot it had queued passes on as soon as its predecessor finishes.
	 */
	const waitTurn = async (slot: QueueSlot, signal: AbortSignal | undefined): Promise<void> => {
		const { key, currentQueue, release } = slot;
		let onStuck: ((error: FileLockedByStuckModuleError) => void) | undefined;
		let onAbort: (() => void) | undefined;
		const refused = new Promise<Error>((resolveRefused) => {
			const stuck = stuckHolders.get(key);
			if (stuck !== undefined) return resolveRefused(stuck);
			onStuck = resolveRefused;
			let waiters = stuckWaiters.get(key);
			if (waiters === undefined) {
				waiters = new Set();
				stuckWaiters.set(key, waiters);
			}
			waiters.add(onStuck);
			if (signal === undefined) return;
			const abortError = () =>
				signal.reason instanceof Error ? signal.reason : new Error("file mutation lock wait cancelled");
			if (signal.aborted) return resolveRefused(abortError());
			onAbort = () => resolveRefused(abortError());
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const outcome = await Promise.race([currentQueue.then(() => undefined), refused]);
			if (outcome === undefined) return;
			// Never held: pass the queued slot on once the predecessor finishes, so the next waiter is not stranded.
			void currentQueue.then(release);
			throw outcome;
		} finally {
			if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
			if (onStuck !== undefined) {
				const waiters = stuckWaiters.get(key);
				waiters?.delete(onStuck);
				if (waiters?.size === 0) stuckWaiters.delete(key);
			}
		}
	};

	const withQueue = async <T>(filePath: string, fn: () => Promise<T>): Promise<T> => {
		const slot = await registerSlot(filePath);
		await waitTurn(slot, undefined);
		try {
			return await fn();
		} finally {
			slot.release();
		}
	};

	return {
		acquire: async (filePath, signal) => {
			const slot = await registerSlot(filePath);
			await waitTurn(slot, signal);
			let held = true;
			const lock = () => {
				if (!held) return;
				held = false;
				stuckHolders.delete(slot.key);
				slot.release();
			};
			lock.markStuck = (holder: string) => {
				if (!held) return;
				const error = new FileLockedByStuckModuleError(filePath, holder);
				stuckHolders.set(slot.key, error);
				for (const fail of stuckWaiters.get(slot.key) ?? []) fail(error);
			};
			return lock;
		},
		withQueue,
		withQueues: async (filePaths, fn) => {
			const byKey = new Map<string, string>();
			for (const filePath of filePaths) {
				const key = await getMutationQueueKey(filePath);
				if (!byKey.has(key)) byKey.set(key, filePath);
			}
			const ordered = [...byKey.keys()].sort().map((key) => byKey.get(key) ?? key);
			const holdFrom = <T>(index: number, run: () => Promise<T>): Promise<T> => {
				const filePath = ordered[index];
				return filePath === undefined ? run() : withQueue(filePath, () => holdFrom(index + 1, run));
			};
			return holdFrom(0, fn);
		},
		stuck: () => ({
			holders: [...stuckHolders.values()].map((error) => ({ path: error.path, holder: error.holder })),
			waiters: [...stuckWaiters.values()].reduce((count, waiters) => count + waiters.size, 0),
		}),
	};
}

const fileMutationQueue = realmRegistry(
	"@code-yeongyu/senpi/file-mutation-queue/v1",
	createFileMutationQueue,
	(value): value is FileMutationQueue => hasFunctions(value, ["acquire", "withQueue", "withQueues", "stuck"]),
);

/**
 * Takes the mutation slot of `filePath` - the same queue and the same file identity as `withFileMutationQueue` - and
 * resolves with its release once every earlier mutation of that file has finished. A waiter whose `signal` aborts
 * rejects without ever holding the slot; the slot it had queued passes on as soon as its predecessor finishes, so later
 * waiters are never stranded. The holder must call the release exactly once (further calls do nothing).
 */
export function acquireFileMutationLock(filePath: string, signal?: AbortSignal): Promise<FileMutationLock> {
	return fileMutationQueue.acquire(filePath, signal);
}

/**
 * Holds the mutation slots of several files for one operation (a rename, a multi-file patch). Paths that name the same
 * file under any spelling (`a.md` and `./a.md`, a case-only alias, a symlink) share one key and take one slot, so the
 * operation never waits on a slot it holds itself; the slots are taken in key order, so two operations over the same
 * files in a different order never wait on each other.
 */
export function withFileMutationQueues<T>(filePaths: readonly string[], fn: () => Promise<T>): Promise<T> {
	return fileMutationQueue.withQueues(filePaths, fn);
}

/**
 * Serialize file mutation operations targeting the same file, across every engine copy in this realm.
 * Operations for different files still run in parallel.
 */
export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return fileMutationQueue.withQueue(filePath, fn);
}
