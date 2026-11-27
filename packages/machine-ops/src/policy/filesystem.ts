import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { MachineOpError } from "../errors.ts";
import { automountTriggerPath, realpathUnderAutomount } from "../files/automount-trigger.ts";
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

/** True leaves the walked entry at `canonicalPath` out of a `find`, `ls` or `grep` result. */
export type FilesystemEntryExclusion = (canonicalPath: string, toolName: string) => boolean;

/** One registered filesystem access policy. `deniedRoots` is metadata; callers enforce `check`. */
export interface FilesystemPolicy {
	check(request: Readonly<FilesystemPolicyRequest>): FilesystemPolicyDecision | Promise<FilesystemPolicyDecision>;
	/**
	 * Asked for every entry a walk below an allowed root would return, before anything is counted from it, so the
	 * result reads as if the entry did not exist. Synchronous because a walk asks it per entry.
	 */
	excludesEntry?: FilesystemEntryExclusion;
	/**
	 * Whether `excludesEntry` could exclude anything below `canonicalRoot`. A walk it answers false for skips the
	 * per-entry filter and the work that filter needs; absent, or throwing, counts as true.
	 */
	prunesBelow?: (canonicalRoot: string, toolName: string) => boolean;
	deniedRoots?: readonly string[];
}

/** Composed deny-wins checker; `entryExclusionBelow` is present when any policy prunes walked entries. */
export type FilesystemPolicyChecker = ((
	request: Readonly<FilesystemPolicyRequest>,
) => Promise<FilesystemPolicyDecision>) & {
	/** The entry filter for a walk below `canonicalRoot`, or undefined when no policy prunes anything there. */
	readonly entryExclusionBelow?: (canonicalRoot: string, toolName: string) => FilesystemEntryExclusion | undefined;
};

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
 * refuses to guess past a non-missing error. The deadline bounds the caller but not the abandoned call, which keeps a
 * thread of the shared filesystem pool until the mount answers (senpi#7157), so a path under an automount trigger that has
 * not mounted is resolved in a child process instead (`automount-realpath.ts`): a working automounter mounts it and the
 * policy sees where its symlinks really lead; one that does not answer leaves the path unknown, and it is refused.
 */
export async function canonicalizeFilesystemPath(filePath: string): Promise<string> {
	const absolutePath = resolve(filePath);
	if ((await automountTriggerPath(absolutePath)) !== undefined) return canonicalizeUnderAutomount(absolutePath);
	const canonicalPath = await withResolutionDeadline(canonicalizeByOpening(absolutePath));
	if (canonicalPath !== RESOLUTION_TIMED_OUT) return canonicalPath;
	return realpathWithoutOpenStrict(absolutePath);
}

async function canonicalizeUnderAutomount(absolutePath: string): Promise<string> {
	const answer = await realpathUnderAutomount(absolutePath);
	switch (answer.kind) {
		case "resolved":
			return answer.path;
		case "failed":
			throw Object.assign(new Error(`${answer.code}: cannot resolve ${absolutePath}`), { code: answer.code });
		case "unanswered":
			throw new MachineOpError(
				"policy_denied",
				`${absolutePath} is under an automount that did not answer, so where it leads is unknown; refused`,
			);
	}
}

/** Compose extension policies in registration order. The first denial wins. */
export function composeFilesystemPolicies(policies: readonly FilesystemPolicy[]): FilesystemPolicyChecker | undefined {
	if (policies.length === 0) return undefined;

	const check = async (request: Readonly<FilesystemPolicyRequest>): Promise<FilesystemPolicyDecision> => {
		for (const policy of policies) {
			const decision = await policy.check(request);
			if (!decision.allow) return decision;
		}
		return ALLOW;
	};
	const pruning = policies.filter((policy) => policy.excludesEntry !== undefined);
	if (pruning.length === 0) return check;
	// A policy that throws prunes and excludes: an answer that failed has not cleared the walk or the entry.
	const entryExclusionBelow = (canonicalRoot: string, toolName: string): FilesystemEntryExclusion | undefined => {
		const active = pruning.filter((policy) =>
			answersTrue(() => policy.prunesBelow?.(canonicalRoot, toolName) ?? true),
		);
		if (active.length === 0) return undefined;
		return (canonicalPath, entryTool) =>
			active.some((policy) => answersTrue(() => policy.excludesEntry?.(canonicalPath, entryTool) ?? false));
	};
	return Object.assign(check, { entryExclusionBelow });
}

function answersTrue(ask: () => boolean): boolean {
	try {
		return ask();
	} catch {
		return true;
	}
}
