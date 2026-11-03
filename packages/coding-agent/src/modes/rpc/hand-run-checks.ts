import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
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

const SHAPE = "local_repo_shape_unsupported";

const kindOf = async (path: string): Promise<"file" | "dir" | "link" | "other" | undefined> => {
	const entry = await lstat(path).catch(() => undefined);
	if (entry === undefined) return undefined;
	return entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
};

/** A git dir in its plainest form: HEAD a regular file, objects/ and refs/ real directories, no redirect of any kind. */
async function plainGitDir(dir: string): Promise<boolean> {
	const [head, objects, refs, commondir, alternates] = await Promise.all(
		["HEAD", "objects", "refs", "commondir", "objects/info/alternates"].map((entry) => kindOf(join(dir, entry))),
	);
	return head === "file" && objects === "dir" && refs === "dir" && commondir === undefined && alternates === undefined;
}

/**
 * The one git dir a local url may name (v2.9, strict canonical shape rather than an emulation of git's lookup). The
 * parent is resolved once (a symlinked ancestor redirects nothing: the policy judges the real path); inside the candidate
 * nothing may redirect: the path itself is no symlink, it is a bare repository or holds a `.git` DIRECTORY, no `<path>.git`
 * sibling exists, and the chosen dir has HEAD/objects/refs as real entries and no `commondir` or `alternates`.
 */
async function canonicalLocalRepo(path: string): Promise<string> {
	const parent = await realpath(dirname(path)).catch(() => undefined);
	if (parent === undefined) throw new DeviceFileError("refused_by_policy", `${SHAPE}: no repository at ${path}`);
	const real = join(parent, basename(path));
	const self = await kindOf(real);
	if (self === "link") throw new DeviceFileError("refused_by_policy", `${SHAPE}: ${path} is a symlink`);
	if (self !== "dir") throw new DeviceFileError("refused_by_policy", `${SHAPE}: no repository at ${path}`);
	if ((await kindOf(`${real}.git`)) !== undefined)
		throw new DeviceFileError("refused_by_policy", `${SHAPE}: ${path}.git exists`);
	const dotGit = await kindOf(join(real, ".git"));
	if (dotGit !== undefined && dotGit !== "dir")
		throw new DeviceFileError("refused_by_policy", `${SHAPE}: ${path}/.git is not a directory`);
	const dir = dotGit === "dir" ? join(real, ".git") : real;
	if (!(await plainGitDir(dir)))
		throw new DeviceFileError("refused_by_policy", `${SHAPE}: ${dir} is not a plain git directory`);
	return dir;
}

/**
 * Confines the typed path arguments of a planned git call (v2.6/v2.7). A `path` must lie inside the worktree or the git
 * directory. A `worktree` (add/remove) must lie outside the git directories, where a worktree would install hooks, and is a
 * policy WRITE. A local url (`source` read, `target` written) may live anywhere (a memory mirror does), so it must name a
 * git dir in strict canonical shape, and that dir is handed to the policy instead of being confined.
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
			if (local === undefined) throw new DeviceFileError("refused_by_policy", `${SHAPE}: ${value}`);
			const gitDir = await canonicalLocalRepo(resolve(cwd, local));
			targets.push({ operation: kind === "source" ? "read" : "write", canonicalPath: gitDir });
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
