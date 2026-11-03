// The one local repository shape a `run` url slot may name (S40 PR 2, design v2.10, senpi#5645). The hand does not emulate
// git's repository lookup (review rounds 1-6 kept finding redirects it missed); it accepts a plain repository at an
// absolute, already-normal path and refuses anything that could redirect git's reads or writes. For a push target it also
// lists the receive-pack hooks git would run, so the hand's handlers judge each one. Refusals are `local_repo_shape_unsupported`.
import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DeviceFileError } from "@earendil-works/pi-agent-core";

const SHAPE = "local_repo_shape_unsupported";
/** Entries the redirect walk inspects before it refuses instead of guessing; a memory mirror has a few hundred refs. */
const WALK_BOUND = 20_000;
/** The hooks receive-pack runs on a push (githooks(5)); only these can execute during `run`'s push. */
const RECEIVE_HOOKS = [
	"pre-receive",
	"update",
	"post-receive",
	"post-update",
	"reference-transaction",
	"push-to-checkout",
];

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
 * anywhere git would follow it: refs/ (all of it), packed-refs, HEAD, config, hooks/, and objects/ with its info/ and
 * pack/ (a loose object's own file is never a redirect; its fan-out directory is checked).
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

/**
 * The receive-pack hooks a push into `dir` would run, for the hand's handlers to judge one by one. The hook directory is
 * `hooks/` or the target's `core.hooksPath` (resolved against the git dir, no symlink at it or inside it); `include.*` and
 * `includeIf.*` are refused because the hand cannot see through them.
 */
async function receiveHooks(dir: string): Promise<readonly string[]> {
	const config = join(dir, "config");
	const entries =
		(await kindOf(config)) === "file"
			? await gitConfig(config).catch(() => refuse("push target config is unreadable"))
			: [];
	if (entries.some(([key]) => key.startsWith("include.") || key.startsWith("includeif.")))
		refuse("push target config uses include/includeIf");
	const custom = entries.filter(([key]) => key === "core.hookspath").at(-1)?.[1] ?? "";
	const hooksDir = custom === "" ? join(dir, "hooks") : resolve(dir, custom);
	if (custom !== "") await noLinks(hooksDir, true, { left: WALK_BOUND });
	const found: string[] = [];
	for (const name of RECEIVE_HOOKS) {
		const path = join(hooksDir, name);
		const entry = await lstat(path).catch(() => undefined);
		if (entry?.isSymbolicLink() === true) refuse(`hook ${path} is a symlink`);
		if (entry?.isFile() === true && (entry.mode & 0o111) !== 0) found.push(path);
	}
	return found;
}

export interface LocalRepo {
	readonly gitDir: string;
	/** Executable receive-pack hooks a push would run (none for a read); the caller judges each as a bash execution. */
	readonly hooks: readonly string[];
}

/**
 * The git dir an absolute, normal local path names, in strict canonical shape. The parent is resolved once (a symlinked
 * ANCESTOR of a normal path redirects nothing: the policy judges the real path); the path itself is no symlink, it is a
 * bare repository or holds a `.git` DIRECTORY, and no `<path>.git` sibling exists.
 */
export async function canonicalLocalRepo(path: string, operation: "read" | "write"): Promise<LocalRepo> {
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
	return { gitDir, hooks: operation === "write" ? await receiveHooks(gitDir) : [] };
}
