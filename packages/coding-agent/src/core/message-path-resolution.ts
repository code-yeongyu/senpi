/**
 * What a path in a message means (#3415): the one rule the TUI, RPC clients and the desktop app
 * share, so the same link opens the same file everywhere.
 *
 * A relative path is tried against the session's working directory first, then the project root
 * (the nearest ancestor of the working directory holding `.git`, else the nearest project marker;
 * a `.git` in the home folder does not count). The first candidate that exists wins, and the
 * answer is its realpath (symlinks and `..` resolved). An absolute path (or `~/...`) is only
 * resolved and checked. This says which file a link means; whether a client may read it stays the
 * client's rule.
 *
 * Only a local path ever reaches the file system (`isLocalMessagePath`): on Windows a local drive-
 * letter path, never a network share or a device/NT-namespace path (`\\host`, `\\?\`, `\\.\`,
 * `\??\`), because merely resolving one makes Windows connect to that host and offer the user's
 * credentials. A message can name any path, so this is checked before every file-system call
 * (#3419 review H1).
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";

import { findProjectRoot } from "./extensions/builtin/rules/rules/project-root.ts";

export type ResolvedMessagePath =
	| {
			readonly status: "found";
			readonly realpath: string;
			readonly kind: "file" | "directory";
			readonly base: "absolute" | "cwd" | "project-root";
	  }
	| { readonly status: "not_found"; readonly tried: readonly string[] };

/** Whether `path` (absolute) is a local path this process may hand to the file system. */
export function isLocalMessagePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
	if (path.includes("\0")) return false;
	if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(path);
	return isAbsolute(path) && !path.startsWith("//");
}

/** The project root a session's relative paths fall back to, or undefined when there is none. */
export function messagePathProjectRoot(cwd: string): string | undefined {
	const home = resolve(homedir());
	const candidate = findProjectRoot(cwd, [".git"]) ?? findProjectRoot(cwd) ?? undefined;
	return candidate === undefined || resolve(candidate) === home ? undefined : candidate;
}

function existing(candidate: string): { realpath: string; kind: "file" | "directory" } | undefined {
	try {
		const realpath = realpathSync.native(candidate);
		const stats = statSync(realpath);
		if (stats.isFile()) return { realpath, kind: "file" };
		if (stats.isDirectory()) return { realpath, kind: "directory" };
		return undefined;
	} catch {
		return undefined;
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}

export function resolveMessagePath(input: {
	readonly path: string;
	readonly cwd: string;
	readonly projectRoot?: string | undefined;
	readonly platform?: NodeJS.Platform;
}): ResolvedMessagePath {
	const platform = input.platform ?? process.platform;
	const pathApi = platform === "win32" ? win32 : { isAbsolute, resolve };
	const path = expandHome(input.path.trim());
	if (path.length === 0 || path.includes("\0")) return { status: "not_found", tried: [] };
	const bases: ReadonlyArray<readonly ["absolute" | "cwd" | "project-root", string]> = pathApi.isAbsolute(path)
		? [["absolute", path]]
		: [
				["cwd", pathApi.resolve(input.cwd, path)],
				...(input.projectRoot !== undefined && pathApi.resolve(input.projectRoot) !== pathApi.resolve(input.cwd)
					? ([["project-root", pathApi.resolve(input.projectRoot, path)]] as const)
					: []),
			];
	const local = bases.filter(([, candidate]) => isLocalMessagePath(candidate, platform));
	if (local.length !== bases.length) return { status: "not_found", tried: [] };
	for (const [base, candidate] of local) {
		const found = existing(candidate);
		if (found !== undefined && isLocalMessagePath(found.realpath, platform)) {
			return { status: "found", ...found, base };
		}
	}
	return { status: "not_found", tried: local.map(([, candidate]) => candidate) };
}
