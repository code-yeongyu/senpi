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
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
