import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LoadedCell =
	| { readonly ok: true; readonly code: string; readonly sourceFile: string }
	| { readonly ok: false; readonly message: string };

export interface LoadCellOptions {
	readonly cwd: string;
	readonly artifactsDir: string | undefined;
}

const MAX_LOAD_BYTES = 8 * 1024 * 1024;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function resolveTarget(target: string, options: LoadCellOptions): { path: string } | { message: string } {
	const scheme = URL_SCHEME.exec(target)?.[1]?.toLowerCase();
	try {
		if (scheme === "file") return { path: fileURLToPath(target) };
		if (scheme === "local") {
			if (options.artifactsDir === undefined)
				return { message: "%load local:// needs a session artifacts directory" };
			const root = join(options.artifactsDir, "local");
			const path = resolve(root, decodeURIComponent(target.slice("local://".length)));
			const inside = relative(root, path);
			if (inside.startsWith("..") || isAbsolute(inside))
				return { message: `%load path escapes local://: ${target}` };
			return { path };
		}
	} catch {
		// fileURLToPath and decodeURIComponent throw on a malformed URL; the message names the user's own text.
		return { message: `%load could not read the path in ${target}` };
	}
	if (scheme !== undefined) {
		return {
			message: `%load reads local files only (a path, local:// or file://); it does not fetch ${scheme}:// URLs`,
		};
	}
	return { path: resolve(options.cwd, target) };
}

/**
 * Reads a `%load` target when its cell's turn comes in the kernel's queue, so a file the previous cell wrote is
 * there. Every failure is a refusal that names the target as the user wrote it, never an absolute path.
 */
export function loadCell(target: string, options: LoadCellOptions): LoadedCell {
	const resolved = resolveTarget(target, options);
	if ("message" in resolved) return { ok: false, message: resolved.message };
	let fd: number | undefined;
	try {
		// One non-blocking open, then checks on that same handle: a FIFO or device swapped in after a check can
		// neither block the host nor be read, and the size cap keeps a huge file from stalling the event loop.
		fd = openSync(resolved.path, constants.O_RDONLY | constants.O_NONBLOCK);
		const info = fstatSync(fd);
		if (!info.isFile()) return { ok: false, message: `not a file: ${target}` };
		if (info.size > MAX_LOAD_BYTES) return { ok: false, message: `%load reads files up to 8 MiB: ${target}` };
		return { ok: true, code: readFileSync(fd, "utf8"), sourceFile: resolved.path };
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, message: `file not found: ${target}` };
		if (code === "EACCES" || code === "EPERM") return { ok: false, message: `permission denied: ${target}` };
		return { ok: false, message: `%load could not read ${target}${code === undefined ? "" : ` (${code})`}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
