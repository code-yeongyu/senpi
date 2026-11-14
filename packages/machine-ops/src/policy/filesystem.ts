import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { MachineOpError } from "../errors.ts";
import { isMissingPathError, RESOLUTION_TIMED_OUT, withResolutionDeadline } from "../files/bounded-realpath.ts";

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

async function canonicalizeByOpening(filePath: string, signal: AbortSignal): Promise<string> {
	let currentPath = filePath;
	const missingSegments: string[] = [];

	for (;;) {
		signal.throwIfAborted();
		try {
			const canonicalParent = await realpath(currentPath);
			signal.throwIfAborted();
			return resolve(canonicalParent, ...missingSegments.reverse());
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}

		try {
			signal.throwIfAborted();
			const stats = await lstat(currentPath);
			signal.throwIfAborted();
			if (stats.isSymbolicLink()) {
				const target = await readlink(currentPath);
				signal.throwIfAborted();
				return canonicalizeByOpening(resolve(dirname(currentPath), target, ...missingSegments.reverse()), signal);
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

/** Resolve symlinks without open(2), without blocking the event loop on a remote lstat. */
async function canonicalizeWithoutOpening(filePath: string, signal: AbortSignal): Promise<string> {
	let root = parse(filePath).root;
	const pending = filePath.slice(root.length).split(sep).filter(Boolean);
	const resolved: string[] = [];
	let hops = 0;
	while (pending.length > 0) {
		signal.throwIfAborted();
		const part = pending.shift();
		if (part === undefined) break;
		if (part === ".") continue;
		if (part === "..") {
			resolved.pop();
			continue;
		}
		const candidate = join(root, ...resolved, part);
		let link: string;
		try {
			const stats = await lstat(candidate);
			signal.throwIfAborted();
			if (!stats.isSymbolicLink()) {
				resolved.push(part);
				continue;
			}
			if (++hops > 40) {
				throw new MachineOpError("io_error", `Too many symbolic links: ${filePath}`);
			}
			link = await readlink(candidate);
			signal.throwIfAborted();
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			return join(candidate, ...pending);
		}
		if (isAbsolute(link)) {
			const linkRoot = parse(link).root;
			root = resolve(root, linkRoot);
			resolved.length = 0;
			pending.unshift(...link.slice(linkRoot.length).split(sep).filter(Boolean));
		} else {
			pending.unshift(...link.split(sep).filter(Boolean));
		}
	}
	return join(root, ...resolved);
}

async function resolveStage(
	operation: (signal: AbortSignal) => Promise<string>,
	callerSignal?: AbortSignal,
): Promise<string | typeof RESOLUTION_TIMED_OUT> {
	const controller = new AbortController();
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	signal.throwIfAborted();
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await withResolutionDeadline(Promise.race([operation(signal), aborted]));
	} finally {
		signal.removeEventListener("abort", onAbort);
		controller.abort();
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
 * traversal is bounded by a deadline; past it a separately bounded async open(2)-free walker
 * answers instead. Both stop scheduling work after cancellation and refuse non-missing errors.
 */
export async function canonicalizeFilesystemPath(filePath: string, signal?: AbortSignal): Promise<string> {
	const absolutePath = resolve(filePath);
	const canonicalPath = await resolveStage((stageSignal) => canonicalizeByOpening(absolutePath, stageSignal), signal);
	if (canonicalPath !== RESOLUTION_TIMED_OUT) return canonicalPath;
	const fallback = await resolveStage((stageSignal) => canonicalizeWithoutOpening(absolutePath, stageSignal), signal);
	if (fallback !== RESOLUTION_TIMED_OUT) return fallback;
	throw new MachineOpError("io_error", `Path resolution timed out: ${absolutePath}`);
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
