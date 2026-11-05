// The one local repository shape a `run` url slot may name (S40 PR 2, design v2.10, senpi#5645). The hand does not emulate
// git's repository lookup (review rounds 1-6 kept finding redirects it missed); it accepts a plain repository at an
// absolute, already-normal path whose config holds only an exact key allowlist (design v3.1), and refuses anything that
// could redirect git's reads or writes. A local push runs a hardened receive-pack (hand-run-transport.ts), so no target hook
// ever runs. Refusals are `local_repo_shape_unsupported`.
import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DeviceFileError } from "@earendil-works/pi-agent-core";

const SHAPE = "local_repo_shape_unsupported";
/** Entries the redirect walk inspects before it refuses instead of guessing; a memory mirror has a few hundred refs. */
const WALK_BOUND = 20_000;

const refuse = (detail: string): never => {
	throw new DeviceFileError("refused_by_policy", `${SHAPE}: ${detail}`);
};

type Kind = "file" | "dir" | "link" | "other";

async function kindOf(path: string): Promise<Kind | undefined> {
	const entry = await lstat(path).catch(() => undefined);
	if (entry === undefined) return undefined;
	return entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
}

/** Refuses a symlink at `path` or (for a directory) among its entries, recursively when asked, within the shared budget. */
async function noLinks(path: string, recursive: boolean, budget: { left: number }): Promise<void> {
	const kind = await kindOf(path);
	if (kind === undefined) return;
	if (kind === "link") refuse(`symlink at ${path}`);
	if (kind !== "dir") return;
	for (const name of await readdir(path)) {
		budget.left -= 1;
		if (budget.left < 0) refuse(`more than ${WALK_BOUND} entries under the repository`);
		const child = join(path, name);
		const childKind = await kindOf(child);
		if (childKind === "link") refuse(`symlink at ${child}`);
		if (recursive && childKind === "dir") await noLinks(child, true, budget);
	}
}

/**
 * The git dir: HEAD a regular file, objects/ and refs/ real directories, no commondir or alternates, and no symlink
 * anywhere git would follow it: refs/ and logs/ (all of them), packed-refs, HEAD, config, hooks/, worktrees/ and each
 * worktrees/<id>, and every entry of objects/ plus info/ and pack/ (a loose object's own file is never a redirect).
 */
async function plainGitDir(dir: string): Promise<void> {
	const [head, objects, refs, commondir, alternates] = await Promise.all(
		["HEAD", "objects", "refs", "commondir", "objects/info/alternates"].map((entry) => kindOf(join(dir, entry))),
	);
	if (head !== "file" || objects !== "dir" || refs !== "dir") refuse(`${dir} is not a plain git directory`);
	if (commondir !== undefined || alternates !== undefined) refuse(`${dir} redirects through commondir or alternates`);
	const budget = { left: WALK_BOUND };
	for (const entry of ["HEAD", "config", "packed-refs"]) await noLinks(join(dir, entry), false, budget);
	await noLinks(join(dir, "refs"), true, budget);
	await noLinks(join(dir, "hooks"), true, budget);
	await noLinks(join(dir, "logs"), true, budget);
	await noLinks(join(dir, "worktrees"), false, budget);
	await noLinks(join(dir, "objects"), false, budget);
	for (const sub of ["info", "pack"]) await noLinks(join(dir, "objects", sub), false, budget);
}

/** `git config --list` of one file, includes NOT followed, under a fixed environment the caller cannot shape. */
function gitConfig(file: string): Promise<readonly (readonly [string, string])[]> {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		LANG: "C",
	};
	return new Promise((done, fail) => {
		execFile(
			"git",
			["config", "--file", file, "--no-includes", "--list", "-z"],
			{ env, timeout: 30_000 },
			(error, stdout) => {
				if (error) return fail(error);
				const records = String(stdout).split("\0").filter(Boolean);
				done(
					records.map((record) => {
						const at = record.indexOf("\n");
						return at < 0 ? ([record, ""] as const) : ([record.slice(0, at), record.slice(at + 1)] as const);
					}),
				);
			},
		);
	});
}

const INIT_KEYS = new Set([
	"core.repositoryformatversion",
	"core.filemode",
	"core.bare",
	"core.ignorecase",
	"core.precomposeunicode",
	"core.logallrefupdates",
]);
const CLONE_KEY = /^remote\..+\.(?:url|fetch|mirror|tagopt)$/;
const WORKING_CLONE_KEY = /^branch\..+\.(?:remote|merge)$|^user\.(?:name|email)$/;

/**
 * The target's config holds ONLY the keys `git init` and `git clone` write (design v3.1, an allowlist, never a denylist):
 * hooks, filters, receive.*, extensions.*, includes and every other execution or redirect key are refused by construction.
 */
async function allowlistedConfig(dir: string, bare: boolean): Promise<void> {
	const config = join(dir, "config");
	if ((await kindOf(config)) !== "file") refuse(`${dir} has no config file`);
	const entries = await gitConfig(config).catch(() => refuse("target config is unreadable"));
	for (const [key, value] of entries) {
		if (key === "core.bare") {
			if (value !== String(bare)) refuse(`core.bare=${value} on a ${bare ? "bare" : "working-clone"} target`);
			continue;
		}
		const allowed = INIT_KEYS.has(key) || CLONE_KEY.test(key) || (!bare && WORKING_CLONE_KEY.test(key));
		if (!allowed) refuse(`target config key ${key} is not allowlisted`);
	}
}

/**
 * The git dir an absolute, normal local path names, in strict canonical shape. The parent is resolved once (a symlinked
 * ANCESTOR of a normal path redirects nothing: the policy judges the real path); the path itself is no symlink, it is a
 * bare repository or a working clone holding a `.git` DIRECTORY, and no `<path>.git` sibling exists.
 */
export async function canonicalLocalRepo(path: string): Promise<string> {
	const parent = await realpath(dirname(path)).catch(() => refuse(`no repository at ${path}`));
	const real = join(parent, basename(path));
	const self = await kindOf(real);
	if (self === "link") refuse(`${path} is a symlink`);
	if (self !== "dir") refuse(`no repository at ${path}`);
	if ((await kindOf(`${real}.git`)) !== undefined) refuse(`${path}.git exists`);
	const dotGit = await kindOf(join(real, ".git"));
	if (dotGit !== undefined && dotGit !== "dir") refuse(`${path}/.git is not a directory`);
	const gitDir = dotGit === "dir" ? join(real, ".git") : real;
	await plainGitDir(gitDir);
	await allowlistedConfig(gitDir, dotGit !== "dir");
	return gitDir;
}
