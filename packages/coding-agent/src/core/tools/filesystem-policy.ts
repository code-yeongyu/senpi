import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { FilesystemPolicy, FilesystemPolicyChecker, FilesystemPolicyDecision } from "../extensions/types.ts";

const ALLOW: FilesystemPolicyDecision = { allow: true };

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/**
 * Resolve a filesystem target through existing symlinks. Missing descendants
 * are appended to the nearest existing real parent so new write targets still
 * receive a stable canonical path.
 */
export async function canonicalizeFilesystemPath(filePath: string): Promise<string> {
	let currentPath = resolve(filePath);
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
				return canonicalizeFilesystemPath(resolve(dirname(currentPath), target, ...missingSegments.reverse()));
			}
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}

		const parentPath = dirname(currentPath);
		if (parentPath === currentPath) {
			return resolve(filePath);
		}
		missingSegments.push(basename(currentPath));
		currentPath = parentPath;
	}
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
