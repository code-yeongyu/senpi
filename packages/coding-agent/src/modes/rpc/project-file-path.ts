/**
 * Which workspace files `read_project_file` / `write_project_file` may touch, and where they resolve on disk.
 *
 * The allowlist is the instruction files the engine itself reads: `AGENTS.md` / `CLAUDE.md` at the workspace root or
 * in any folder below it, and anything under `.omo/rules/`. A path is relative, `/`-separated and canonical (no empty,
 * `.` or `..` segment), and never passes through `.git` or `node_modules`. Resolution walks the path one segment at a
 * time with `lstat` from the real workspace root and refuses any symlink or non-folder on the way, so neither a
 * traversal nor a link can reach a file outside the workspace. On top of that, `insideUserGlobalRoots` refuses a
 * real path in any user-global root the engine loads, so a session whose folder contains such a root (a session
 * opened in `$HOME`) still cannot reach user-global configuration through these verbs (senpi#6547 review LOWs).
 */

import { constants } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { userGlobalSkillRoots } from "../../core/skills.ts";

/** Under the host's 1,000,000-character message limit, so an oversized write reaches this typed refusal. */
export const PROJECT_FILE_MAX_BYTES = 512 * 1024;

const INSTRUCTION_FILE_NAMES: ReadonlySet<string> = new Set(["AGENTS.md", "CLAUDE.md"]);
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([".git", "node_modules"]);
const FORBIDDEN_CHARACTERS = /[\\:\0]/;

/** `O_NOFOLLOW` where the platform has it, so a link swapped in after resolution still fails the open. */
export const NO_FOLLOW: number = constants.O_NOFOLLOW ?? 0;

export interface ProjectFilePath {
	readonly relative: string;
	readonly segments: readonly string[];
}

export function parseProjectFilePath(input: string): ProjectFilePath | undefined {
	if (input.length === 0 || input.startsWith("/") || FORBIDDEN_CHARACTERS.test(input)) return undefined;
	const segments = input.split("/");
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === ".." || EXCLUDED_SEGMENTS.has(segment)) return undefined;
	}
	const name = segments[segments.length - 1] ?? "";
	const isRule = segments.length >= 3 && segments[0] === ".omo" && segments[1] === "rules";
	if (!isRule && !INSTRUCTION_FILE_NAMES.has(name)) return undefined;
	return { relative: segments.join("/"), segments };
}

export type ResolvedProjectFile =
	| {
			readonly ok: true;
			readonly absolute: string;
			readonly exists: boolean;
			readonly missingFolders: readonly string[];
	  }
	| { readonly ok: false };

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function lstatOrMissing(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** Resolves `file` inside the real workspace root; `missingFolders` are the parent folders a write must create. */
export async function resolveProjectFile(cwd: string, file: ProjectFilePath): Promise<ResolvedProjectFile> {
	let current = await realpath(cwd);
	const folders = file.segments.slice(0, -1);
	const missingFolders: string[] = [];
	for (const folder of folders) {
		current = join(current, folder);
		if (missingFolders.length > 0) {
			missingFolders.push(current);
			continue;
		}
		const stat = await lstatOrMissing(current);
		if (stat === undefined) missingFolders.push(current);
		else if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false };
	}
	const absolute = join(current, file.segments[file.segments.length - 1] ?? "");
	if (missingFolders.length > 0) return { ok: true, absolute, exists: false, missingFolders };
	const stat = await lstatOrMissing(absolute);
	if (stat === undefined) return { ok: true, absolute, exists: false, missingFolders };
	if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false };
	return { ok: true, absolute, exists: true, missingFolders };
}

/**
 * The real path of `path`; a missing path is its nearest existing parent's real path plus the missing rest, so a root
 * not created yet still compares by real path when a parent (such as `$HOME`) is a link (senpi#6558).
 */
async function realpathOfNearest(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
		const parent = dirname(path);
		return parent === path ? path : join(await realpathOfNearest(parent), basename(path));
	}
}

/** True when `absolute` equals `root` or lies inside it, `root` by real path. */
async function insideRealRoot(root: string, absolute: string): Promise<boolean> {
	const path = relative(await realpathOfNearest(resolve(root)), absolute);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/**
 * True when the resolved `absolute` is the agent dir or lies inside it, compared by real path: that is the machine's
 * global config, never a project file, even when the session folder is the agent dir's parent (or `$HOME`).
 */
export async function insideAgentDir(agentDir: string, absolute: string): Promise<boolean> {
	return insideRealRoot(agentDir, absolute);
}

/**
 * True when the resolved `absolute` lies in any user-global root the engine loads: the agent dir (its context file,
 * its skills, the global MCP file) or any user-global skill root, taken from `userGlobalSkillRoots` over the loader's
 * `getUserSkillRoots` (each loaded user skill's own folder, never a whole package folder). Such a file is user-global
 * configuration, never a project file, even when the session folder contains the root (a session opened in `$HOME`)
 * or reaches it through a link; the comparison is by real path (senpi#6547 review LOWs).
 */
export async function insideUserGlobalRoots(
	agentDir: string,
	userSkillRoots: readonly string[],
	absolute: string,
): Promise<boolean> {
	if (await insideAgentDir(agentDir, absolute)) return true;
	for (const root of userGlobalSkillRoots(agentDir, userSkillRoots)) {
		if (await insideRealRoot(root, absolute)) return true;
	}
	return false;
}

/**
 * Creates the missing parent folders one at a time; a non-recursive `mkdir` fails on anything that appeared in the
 * meantime, and each new folder is re-checked as a real folder before the next one is made inside it.
 */
export async function createMissingFolders(folders: readonly string[]): Promise<boolean> {
	for (const folder of folders) {
		try {
			await mkdir(folder);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const stat = await lstat(folder);
		if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
	}
	return true;
}
