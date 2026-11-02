import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { realpathWithoutOpenStrict } from "../../utils/paths.ts";
import {
	foldPathForCaseInsensitiveFilesystem,
	isMissingPathError,
	RESOLUTION_TIMED_OUT,
	withResolutionDeadline,
} from "./bounded-realpath.ts";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

/**
 * Every spelling of one file must produce one key, or two mutations of that file run concurrently
 * and the later write silently discards the earlier one. `realpath` supplies that identity,
 * including the on-disk case of an alias such as `Notes.txt` vs `notes.txt`; a path that does not
 * exist yet keys on the canonical form of its nearest existing ancestor plus the missing tail, so a
 * file a reservation creates or deletes keeps one identity. On a wedged mount `realpath` never returns, so the
 * resolution is bounded and falls back to the open(2)-free walker, and the key is case-folded on
 * filesystems that ignore case so the fallback and the fast path agree on the same file.
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	const canonicalPath = await withResolutionDeadline(realpath(resolvedPath)).catch((error: unknown) => {
		if (isMissingPathError(error)) return realpathWithoutOpenStrict(resolvedPath);
		throw error;
	});
	const identity = canonicalPath === RESOLUTION_TIMED_OUT ? realpathWithoutOpenStrict(resolvedPath) : canonicalPath;
	return foldPathForCaseInsensitiveFilesystem(identity);
}

/**
 * A file whose slot is held by a module that is stuck (past its deadline and grace, still running in this process where
 * nothing can stop it). The slot stays held - releasing it could let a second writer interleave with a write still in
 * flight - so every waiter fails with this instead of waiting forever.
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

/** Keys whose holder is stuck, and the waiters to fail when a holder becomes stuck. */
const stuckHolders = new Map<string, FileLockedByStuckModuleError>();
const stuckWaiters = new Map<string, Set<(error: FileLockedByStuckModuleError) => void>>();

interface QueueSlot {
	readonly keys: readonly string[];
	readonly currentQueue: Promise<void>;
	readonly release: () => void;
}

function registerSlots(filePaths: readonly string[]): Promise<QueueSlot> {
	const registration = registrationQueue.then(async () => {
		const keys = [...new Set(await Promise.all(filePaths.map(getMutationQueueKey)))];
		const currentQueue = Promise.all(keys.map((key) => fileMutationQueues.get(key))).then(() => undefined);

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		for (const key of keys) fileMutationQueues.set(key, chainedQueue);

		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			releaseNext();
			for (const key of keys) {
				if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
			}
		};
		return { keys, currentQueue, release };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);
	return registration;
}

/**
 * Waits for the slot's turn; a waiter whose `signal` aborts, or whose slot touches a file whose holder is (or becomes)
 * stuck, rejects without ever holding the slot, and the slot it had queued passes on as soon as its predecessor
 * finishes.
 */
async function waitTurn(slot: QueueSlot, signal: AbortSignal | undefined): Promise<void> {
	const { keys, currentQueue, release } = slot;
	type StuckSubscription = { readonly key: string; readonly refuse: (error: FileLockedByStuckModuleError) => void };
	const stuckSubscriptions: StuckSubscription[] = [];
	let onAbort: (() => void) | undefined;
	const refused = new Promise<Error>((resolveRefused) => {
		for (const key of keys) {
			const stuck = stuckHolders.get(key);
			if (stuck !== undefined) return resolveRefused(stuck);
			const refuse = (error: FileLockedByStuckModuleError) => resolveRefused(error);
			stuckSubscriptions.push({ key, refuse });
			let waiters = stuckWaiters.get(key);
			if (waiters === undefined) {
				waiters = new Set();
				stuckWaiters.set(key, waiters);
			}
			waiters.add(refuse);
		}
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
		for (const { key, refuse } of stuckSubscriptions) {
			const waiters = stuckWaiters.get(key);
			waiters?.delete(refuse);
			if (waiters?.size === 0) stuckWaiters.delete(key);
		}
	}
}

/** The holder's side of a slot: release it, or mark its holder stuck (the slot stays held; every waiter fails fast). */
export interface FileMutationLock {
	(): void;
	markStuck(holder: string): void;
}

/**
 * Takes the mutation slot of `filePath` - the same queue and the same file identity as `withFileMutationQueue` - and
 * resolves with its release once every earlier mutation of that file has finished. A waiter whose `signal` aborts
 * rejects without ever holding the slot; the slot it had queued passes on as soon as its predecessor finishes, so later
 * waiters are never stranded. The holder must call the release exactly once (further calls do nothing).
 */
export async function acquireFileMutationLock(filePath: string, signal?: AbortSignal): Promise<FileMutationLock> {
	const slot = await registerSlots([filePath]);
	await waitTurn(slot, signal);
	let held = true;
	const lock = () => {
		if (!held) return;
		held = false;
		for (const key of slot.keys) stuckHolders.delete(key);
		slot.release();
	};
	lock.markStuck = (holder: string) => {
		if (!held) return;
		const error = new FileLockedByStuckModuleError(filePath, holder);
		for (const key of slot.keys) {
			stuckHolders.set(key, error);
			for (const fail of stuckWaiters.get(key) ?? []) fail(error);
		}
	};
	return lock;
}

/**
 * Serialize one mutation transaction across every file it touches: all canonical identities are reserved before `fn`
 * runs, so a transaction spanning several paths stays isolated from every single-file mutation of those paths, and
 * aliases of one file are reserved once. Operations for unrelated files still run in parallel.
 */
export async function withFileMutationQueues<T>(filePaths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const slot = await registerSlots(filePaths);
	await waitTurn(slot, undefined);
	try {
		return await fn();
	} finally {
		slot.release();
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return withFileMutationQueues([filePath], fn);
}
