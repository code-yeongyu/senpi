import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LoadedCell =
	| { readonly ok: true; readonly code: string; readonly sourceFile: string }
	| { readonly ok: false; readonly message: string };

export interface LoadCellOptions {
	readonly cwd: string;
	readonly artifactsDir: string | undefined;
}

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

function resolveTarget(target: string, options: LoadCellOptions): { path: string } | { message: string } {
	const scheme = URL_SCHEME.exec(target)?.[1]?.toLowerCase();
	if (scheme === "file") return { path: fileURLToPath(target) };
	if (scheme === "local") {
		if (options.artifactsDir === undefined) return { message: "%load local:// needs a session artifacts directory" };
		const root = join(options.artifactsDir, "local");
		const path = resolve(root, decodeURIComponent(target.slice("local://".length)));
		const inside = relative(root, path);
		if (inside.startsWith("..") || isAbsolute(inside)) return { message: `%load path escapes local://: ${target}` };
		return { path };
	}
	if (scheme !== undefined) {
		return {
			message: `%load reads local files only (a path, local:// or file://); it does not fetch ${scheme}:// URLs`,
		};
	}
	return { path: resolve(options.cwd, target) };
}

export async function loadCell(target: string, options: LoadCellOptions): Promise<LoadedCell> {
	const resolved = resolveTarget(target, options);
	if ("message" in resolved) return { ok: false, message: resolved.message };
	try {
		const info = await stat(resolved.path);
		if (!info.isFile()) return { ok: false, message: `not a file: ${target}` };
		return { ok: true, code: await readFile(resolved.path, "utf8"), sourceFile: resolved.path };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { ok: false, message: `file not found: ${target}` };
		}
		throw error;
	}
}
