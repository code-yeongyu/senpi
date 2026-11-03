import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DeviceFileError } from "@earendil-works/pi-agent-core";
import { canonicalizeFilesystemPath } from "../../core/tools/filesystem-policy.ts";
import { localUrlPath, type TypedPath } from "./hand-run-grammar.ts";

const MIN_GIT: readonly [number, number] = [2, 29];

function git(argv: readonly string[], cwd: string, env: Record<string, string>): Promise<string> {
	return new Promise((done, fail) => {
		execFile("git", [...argv], { cwd, env, timeout: 30_000, windowsHide: true }, (error, stdout) =>
			error ? fail(error) : done(String(stdout)),
		);
	});
}

let versionChecked: Promise<boolean> | undefined;

/** The hand's git is at least 2.29 (every subcommand in the allowlist is then a builtin, never an alias or a PATH lookup). */
export function gitIsSupported(env: Record<string, string>): Promise<boolean> {
	versionChecked ??= git(["--version"], process.cwd(), env).then(
		(output) => {
			const match = /git version (\d+)\.(\d+)/.exec(output);
			if (match === null) return false;
			const [major, minor] = [Number(match[1]), Number(match[2])];
			return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
		},
		() => false,
	);
	return versionChecked;
}

/** The run's working directory: resolved against the scope root, canonical, and an existing directory. */
export async function runDirectory(root: string, cwd: string): Promise<string> {
	const canonical = await canonicalizeFilesystemPath(resolve(root, cwd));
	const entry = await stat(canonical).catch(() => undefined);
	if (entry === undefined) throw new DeviceFileError("not_found", cwd);
	if (!entry.isDirectory()) throw new DeviceFileError("not_a_file", cwd);
	return canonical;
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}${sep}`);

/**
 * `GIT_INDEX_FILE` must name a file inside the repository's own git directory (or the common one of a linked worktree).
 * The hand asks git for both itself, canonicalizes the given file's PARENT (the file and its `.lock` may not exist yet),
 * and hands the child the canonical path; anything else is refused.
 */
export async function confinedIndexFile(value: string, cwd: string, env: Record<string, string>): Promise<string> {
	if (!isAbsolute(value)) throw new DeviceFileError("refused_by_policy", "GIT_INDEX_FILE must be absolute");
	const dirs = await gitDirs(cwd, env);
	const parent = await canonicalizeFilesystemPath(dirname(value));
	if (!dirs.some((dir) => inside(parent, dir)))
		throw new DeviceFileError("refused_by_policy", "GIT_INDEX_FILE is outside the repository's git directory");
	return join(parent, basename(value));
}

async function gitDirs(cwd: string, env: Record<string, string>): Promise<readonly string[]> {
	const [gitDir, commonDir] = (await git(["rev-parse", "--absolute-git-dir", "--git-common-dir"], cwd, env))
		.trim()
		.split("\n");
	if (gitDir === undefined || commonDir === undefined)
		throw new DeviceFileError("refused_by_policy", "no repository at cwd");
	return Promise.all([gitDir, resolve(cwd, commonDir)].map((dir) => canonicalizeFilesystemPath(dir)));
}

/** The canonical location of `raw` (resolved against `cwd`); a symlink as the LAST component is refused, never followed. */
async function canonicalTarget(raw: string, cwd: string): Promise<string> {
	const target = resolve(cwd, raw);
	const entry = await lstat(target).catch(() => undefined);
	if (entry?.isSymbolicLink() === true) throw new DeviceFileError("refused_by_policy", `symlink: ${raw}`);
	return join(await canonicalizeFilesystemPath(dirname(target)), basename(target));
}

/** A filesystem location a planned git call reads or writes outside the confinement rules, for the hand's policy. */
export interface PolicyTarget {
	readonly operation: "read" | "write";
	readonly canonicalPath: string;
}

/**
 * Confines the typed path arguments of a planned git call (v2.6/v2.7). A `path` must lie inside the worktree or the git
 * directory. A `worktree` (add/remove) must lie outside the git directories, where a worktree would install hooks, and is a
 * policy WRITE. A local url (`source` read, `target` written) may live anywhere (a memory mirror does), so it is resolved
 * through every symlink, its last component included, and handed to the policy instead of being confined.
 */
export async function confinePaths(
	paths: readonly TypedPath[],
	cwd: string,
	env: Record<string, string>,
): Promise<readonly PolicyTarget[]> {
	if (paths.length === 0) return [];
	const dirs = await gitDirs(cwd, env);
	const top = await git(["rev-parse", "--show-toplevel"], cwd, env).then(
		(output) => canonicalizeFilesystemPath(output.trim()),
		() => undefined,
	);
	const targets: PolicyTarget[] = [];
	for (const { kind, value } of paths) {
		if (kind === "source" || kind === "target") {
			const local = localUrlPath(value);
			if (local === undefined) throw new DeviceFileError("refused_by_policy", `url: ${value}`);
			const canonicalPath = await canonicalizeFilesystemPath(resolve(cwd, local));
			targets.push({ operation: kind === "source" ? "read" : "write", canonicalPath });
			continue;
		}
		const canonical = await canonicalTarget(value, cwd);
		const inGitDir = dirs.some((dir) => inside(canonical, dir) || (kind === "worktree" && inside(dir, canonical)));
		if (kind === "worktree") {
			if (inGitDir)
				throw new DeviceFileError("refused_by_policy", "worktree path is inside the repository's git directory");
			targets.push({ operation: "write", canonicalPath: canonical });
		} else if (!inGitDir && (top === undefined || !inside(canonical, top)))
			throw new DeviceFileError("refused_by_policy", `path outside the repository: ${value}`);
	}
	return targets;
}
