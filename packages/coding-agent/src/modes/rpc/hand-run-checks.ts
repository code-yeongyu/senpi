import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DeviceFileError } from "@earendil-works/pi-agent-core";
import { canonicalizeFilesystemPath } from "../../core/tools/filesystem-policy.ts";

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
	const [gitDir, commonDir] = (await git(["rev-parse", "--absolute-git-dir", "--git-common-dir"], cwd, env))
		.trim()
		.split("\n");
	if (gitDir === undefined || commonDir === undefined)
		throw new DeviceFileError("refused_by_policy", "GIT_INDEX_FILE: no repository at cwd");
	const dirs = await Promise.all([gitDir, resolve(cwd, commonDir)].map((dir) => canonicalizeFilesystemPath(dir)));
	const parent = await canonicalizeFilesystemPath(dirname(value));
	if (!dirs.some((dir) => inside(parent, dir)))
		throw new DeviceFileError("refused_by_policy", "GIT_INDEX_FILE is outside the repository's git directory");
	return join(parent, basename(value));
}
