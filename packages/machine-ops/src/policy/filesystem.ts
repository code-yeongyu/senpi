import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isMissingPathError, RESOLUTION_TIMED_OUT, withResolutionDeadline } from "../files/bounded-realpath.ts";
import { realpathWithoutOpenStrict } from "../files/realpath-without-open.ts";

/** What a built-in file operation is about to do with a path. */
export type FilesystemOperation = "read" | "enumerate" | "write";

export interface FilesystemPolicyRequest {
	operation: FilesystemOperation;
	canonicalPath: string;
	toolName: string;
}

/** A filesystem policy must explicitly allow or deny each request. */
export type FilesystemPolicyDecision = { allow: true } | { allow: false; reason: string };

/** One registered filesystem access policy. `deniedRoots` is metadata; callers enforce `check`. */
export interface FilesystemPolicy {
	check(request: Readonly<FilesystemPolicyRequest>): FilesystemPolicyDecision | Promise<FilesystemPolicyDecision>;
	deniedRoots?: readonly string[];
}

/** Composed deny-wins checker. */
export type FilesystemPolicyChecker = (request: Readonly<FilesystemPolicyRequest>) => Promise<FilesystemPolicyDecision>;

const ALLOW: FilesystemPolicyDecision = { allow: true };

async function canonicalizeByOpening(filePath: string): Promise<string> {
	let currentPath = filePath;
	const missingSegments: string[] = [];

	for (;;) {
		try {
			const canonicalParent = await realpath(currentPath);
			return resolve(canonicalParent, ...missingSegments.reverse());
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}

		try {
			const stats = await lstat(currentPath);
			if (stats.isSymbolicLink()) {
				const target = await readlink(currentPath);
				return canonicalizeByOpening(resolve(dirname(currentPath), target, ...missingSegments.reverse()));
			}
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}

		const parentPath = dirname(currentPath);
		if (parentPath === currentPath) {
			return filePath;
		}
		missingSegments.push(basename(currentPath));
		currentPath = parentPath;
	}
}

/**
 * Resolve a filesystem target through existing symlinks. Missing descendants
 * are appended to the nearest existing real parent so new write targets still
 * receive a stable canonical path.
 *
 * The answer feeds extension containment decisions, so it comes from real `realpath` traversal:
 * that is what supplies the on-disk case of a case-insensitive name, applies `..` the way the
 * following I/O will, and fails closed on EACCES/EIO/ELOOP instead of guessing. Because this runs
 * before every read/ls/grep/find/edit/write and `realpath` never returns on a wedged mount, the
 * traversal is bounded by a deadline; past it the open(2)-free walker answers instead, which still
 * refuses to guess past a non-missing error.
 */
export async function canonicalizeFilesystemPath(filePath: string): Promise<string> {
	const absolutePath = resolve(filePath);
	const canonicalPath = await withResolutionDeadline(canonicalizeByOpening(absolutePath));
	if (canonicalPath !== RESOLUTION_TIMED_OUT) return canonicalPath;
	return realpathWithoutOpenStrict(absolutePath);
}

/** Compose extension policies in registration order. The first denial wins. */
export function composeFilesystemPolicies(policies: readonly FilesystemPolicy[]): FilesystemPolicyChecker | undefined {
	if (policies.length === 0) return undefined;

	return async (request) => {
		for (const policy of policies) {
			const decision = await policy.check(request);
			if (!decision.allow) return decision;
		}
		return ALLOW;
	};
}
