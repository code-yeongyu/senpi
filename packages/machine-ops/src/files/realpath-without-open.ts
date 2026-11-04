import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, join, resolve as nodeResolvePath, parse, sep } from "node:path";

/** Symlink hops allowed while resolving one path; realpath(3) reports ELOOP past this. */
const MAX_SYMLINK_HOPS = 40;

/** Error codes that mean "this component does not exist", which resolution tolerates. */
const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

function splitParts(pathSegment: string): string[] {
	return pathSegment.split(sep).filter((part) => part.length > 0);
}

interface OpenFreeResolution {
	/** The resolved path; components from an unresolvable one onward are kept verbatim. */
	readonly path: string;
	/** Set when resolution stopped early: the fs error code, or ELOOP for hop exhaustion. */
	readonly errorCode?: string;
}

/**
 * realpath(3) semantics with one lstat/readlink per component and no open(2) anywhere.
 *
 * `..` is applied to the already-resolved prefix rather than collapsed lexically, because the two
 * differ whenever a link target reaches back through a symlink: for `entry -> jump/../secret` with
 * `jump -> /elsewhere/dir`, POSIX resolves `jump` first and lands in `/elsewhere/secret`, while a
 * lexical collapse would answer `secret` next to `entry`. Handing a lexical answer to a
 * containment decision would approve one directory while the I/O reached another, so neither the
 * input nor a link target is normalized before traversal.
 */
function resolveWithoutOpen(inputPath: string): OpenFreeResolution {
	const absolutePath = isAbsolute(inputPath) ? inputPath : nodeResolvePath(inputPath);
	const { root } = parse(absolutePath);
	const pending = splitParts(absolutePath.slice(root.length));
	const resolved: string[] = [];
	let hops = 0;
	while (pending.length > 0) {
		const part = pending.shift();
		if (part === undefined) break;
		if (part === ".") continue;
		if (part === "..") {
			// At the root `..` is the root itself, which an empty stack already represents.
			resolved.pop();
			continue;
		}
		const candidate = join(root, ...resolved, part);
		let link: string;
		try {
			if (!lstatSync(candidate).isSymbolicLink()) {
				resolved.push(part);
				continue;
			}
			hops += 1;
			if (hops > MAX_SYMLINK_HOPS) return { path: join(candidate, ...pending), errorCode: "ELOOP" };
			link = readlinkSync(candidate);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
			return { path: join(candidate, ...pending), errorCode: code };
		}
		if (isAbsolute(link)) {
			resolved.length = 0;
			pending.unshift(...splitParts(link.slice(parse(link).root.length)));
		} else {
			pending.unshift(...splitParts(link));
		}
	}
	return { path: join(root, ...resolved) };
}

/**
 * Resolve symlinks without ever open(2)-ing a component, tolerating every error.
 *
 * Bun's `fs.realpath*` opens every directory it resolves, so an autofs trigger such as macOS
 * `/home` blocks the calling thread (on the host main thread that freezes the TUI) and an
 * execute-only directory fails with EACCES; lstat needs only search permission and never mounts
 * anything. Components from the first unresolvable one onward are kept verbatim, so a file that
 * does not exist yet still lands where its symlinked parent points.
 *
 * Never throws, so the resolved path may be incomplete. Use it where an approximate answer is
 * better than a blocked thread — the external-path classifier and the monitor parent identity —
 * and use {@link realpathWithoutOpenStrict} where an incomplete answer must not be trusted.
 */
export function realpathWithoutOpen(inputPath: string): string {
	return resolveWithoutOpen(inputPath).path;
}

/**
 * {@link realpathWithoutOpen} that refuses to answer with a guess: a missing component is still
 * tolerated (its name is appended verbatim, which is what a not-yet-created target needs), but
 * EACCES, EIO, ELOOP and hop exhaustion throw instead of returning an unresolved path. Callers
 * that feed a canonical path into a containment or identity decision need this contract, because
 * an unresolved path can name a different file than the one the I/O will reach.
 */
export function realpathWithoutOpenStrict(inputPath: string): string {
	const resolution = resolveWithoutOpen(inputPath);
	if (resolution.errorCode !== undefined && !MISSING_PATH_CODES.has(resolution.errorCode)) {
		throw Object.assign(new Error(`${resolution.errorCode}: cannot resolve path '${inputPath}' without opening it`), {
			code: resolution.errorCode,
			path: inputPath,
		});
	}
	return resolution.path;
}
