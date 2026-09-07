import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface PathInputOptions {
	/** Trim leading/trailing whitespace before normalization. */
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	normalizeUnicodeSpaces?: boolean;
}

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

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

export function getFileRevision(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return undefined;
	}
}

/**
 * Returns true if the value is NOT a package source (npm:, git:, etc.)
 * or a remote URL protocol. Bare names, relative paths, and file: URLs
 * are considered local.
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// Known non-local prefixes. file: URLs are local paths and are intentionally resolved by resolvePath().
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	) {
		return false;
	}
	return true;
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
export function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (process.platform === "win32") {
		normalized = normalizeWindowsShellPath(normalized);
	}

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

export function shortenPath(path: string): string {
	if (!path) return path;
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

export function markPathIgnoredByCloudSync(path: string): void {
	const attrs =
		process.platform === "darwin"
			? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: process.platform === "linux"
				? ["user.com.dropbox.ignored"]
				: [];

	for (const attr of attrs) {
		if (process.platform === "darwin") {
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
