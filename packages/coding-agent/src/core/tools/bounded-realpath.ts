/**
 * Canonical-path resolution that is correct first and bounded second.
 *
 * A canonical path handed to a containment decision or used as a same-file identity key must come
 * from real `realpath` resolution: only the kernel knows the on-disk spelling of a case-insensitive
 * name, and only per-component traversal applies `..` the way the subsequent I/O will. The
 * open(2)-free walker in `utils/paths.ts` cannot supply either, so it is a fallback, not a
 * replacement.
 *
 * `realpath` can also never return: on a wedged mount (a macOS autofs trigger whose automounter
 * does not answer) Bun's implementation blocks in `open(2)` forever, and these helpers run before
 * every read/ls/grep/find/edit/write. Racing the resolution against a deadline keeps the caller
 * bounded; the pending operation itself cannot be cancelled, so it is left with a handler attached
 * and its result discarded.
 */

export const RESOLUTION_DEADLINE_MS = 2000;

export const RESOLUTION_TIMED_OUT = Symbol("resolution-timed-out");

export function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

export async function withResolutionDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number = RESOLUTION_DEADLINE_MS,
): Promise<T | typeof RESOLUTION_TIMED_OUT> {
	// Attach a handler now: once the deadline wins, nothing else observes this promise, and a later
	// rejection would surface as an unhandled rejection. The race still sees the original result.
	operation.catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof RESOLUTION_TIMED_OUT>((resolveDeadline) => {
		timer = setTimeout(() => resolveDeadline(RESOLUTION_TIMED_OUT), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([operation, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Fold a path into a same-file identity key on filesystems that ignore case.
 *
 * Used only for serialization keys, never for a path handed back to the filesystem or to a policy.
 * Folding can only make two distinct files share a key, which serializes them unnecessarily;
 * failing to fold lets two spellings of ONE file run concurrently, which loses writes.
 */
export function foldPathForCaseInsensitiveFilesystem(filePath: string): string {
	if (process.platform === "linux") return filePath;
	return filePath.normalize("NFC").toLowerCase();
}
