// What the file tools need from the host they run for, with defaults that need no Node runtime. The local tools
// pass their Node implementations (path-utils.ts, the machine-ops mutation queue and realpath canonicalization).

import type { OpContext } from "@code-yeongyu/senpi-machine-ops";
import type { ToolMachine } from "./tool-machine.ts";

/** Resolves a model-given path against the working directory. */
export type ToolPathResolver = (path: string, cwd: string) => string;
/** Serializes the mutations of one file. */
export type FileMutationQueue = <T>(absolutePath: string, fn: () => Promise<T>) => Promise<T>;
/** The path an extension filesystem policy judges. */
export type ToolPathCanonicalizer = (absolutePath: string) => Promise<string>;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePosixPath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/**
 * POSIX resolution as `path.posix.resolve` does it, after the same input clean-up the local resolver applies (Unicode
 * spaces, a leading `@`, `file://` URLs). `~` is not expanded: the host's home directory is unknown here.
 */
export const resolvePosixToolPath: ToolPathResolver = (input, cwd) => {
	let path = input.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path.startsWith("file://")) path = decodeURIComponent(new URL(path).pathname);
	return normalizePosixPath(path.startsWith("/") ? path : `${cwd}/${path}`);
};

export function posixDirname(path: string): string {
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	const slash = trimmed.lastIndexOf("/");
	if (slash === -1) return ".";
	return slash === 0 ? "/" : trimmed.slice(0, slash);
}

const pathTails = new Map<string, Promise<void>>();

/** Serializes mutations per resolved path string within this isolate. */
export const inProcessFileMutationQueue: FileMutationQueue = async (absolutePath, fn) => {
	const previous = pathTails.get(absolutePath) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	pathTails.set(absolutePath, tail);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (pathTails.get(absolutePath) === tail) pathTails.delete(absolutePath);
	}
};

export const lexicalCanonicalPath: ToolPathCanonicalizer = async (absolutePath) => absolutePath;

/**
 * Refuses a target the machine's `files.stat` reports as `other`: neither a regular file, a directory nor a symlink,
 * such as a FIFO, a device or a socket. Opening a FIFO waits for a peer that may never come and a device may never
 * reach end of file, so the file tools refuse such a target before they open it (senpi#2888). A target the machine
 * cannot stat passes, so the tool's own access check or open still reports it as before.
 */
export async function refuseSpecialFile(
	machine: ToolMachine,
	ctx: OpContext,
	absolutePath: string,
	displayPath: string,
	verb: "edit" | "write" | "read",
): Promise<void> {
	const type = await machine.ops.files.stat({ path: absolutePath }, ctx).then(
		(stat) => stat.type,
		() => undefined,
	);
	if (type !== "other") return;
	throw new Error(`Could not ${verb} file: ${displayPath}. It is a special file, not a regular file.`);
}

const NARROW_NO_BREAK_SPACE = "\u202F";

export function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

export function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

export function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

// Windows Explorer "Copy as path" wraps the path in double quotes (senpi#2170).
export function unquotedPath(filePath: string): string | undefined {
	const match = /^@?(["'])(.+)\1$/.exec(filePath.trim());
	return match?.[2];
}

/**
 * The read tool's path: the resolved path when it exists, else the first existing spelling variant (quoted,
 * macOS screenshot AM/PM, NFD, curly quote), else the resolved path.
 */
export async function resolveReadPathVariants(
	filePath: string,
	cwd: string,
	resolve: ToolPathResolver,
	exists: (path: string) => Promise<boolean>,
): Promise<string> {
	const resolved = resolve(filePath, cwd);

	if (await exists(resolved)) {
		return resolved;
	}

	const unquoted = unquotedPath(filePath);
	if (unquoted !== undefined) {
		return resolveReadPathVariants(unquoted, cwd, resolve, exists);
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await exists(amPmVariant))) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await exists(nfdVariant))) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await exists(curlyVariant))) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await exists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
