import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../tools/path-utils.ts";

/**
 * The working folder a moved session leaves behind (senpi#3676, design v7 section 6). The receiver uses its own checkout
 * of the same repository, so only what git cannot fetch travels: the uncommitted changes, as one binary patch against
 * the sender's HEAD. The sender first checks that HEAD is on a remote, so the receiver can have the same commit.
 */
export const WORKING_TREE_PAYLOAD = "working-tree";
const PATCH_FILE = "changes.patch";
const HEAD_FILE = "head";
/** A patch larger than this is refused rather than carried: the move is for a session, not for a folder. */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

const GIT_TIMEOUT_MS = 30_000;
// An inherited repository location would point every command at that one repository.
const GIT_LOCATION_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]);

interface GitResult {
	readonly ok: boolean;
	readonly stdout: Buffer;
}

const text = (result: GitResult) => result.stdout.toString("utf8").trim();

function git(
	dir: string,
	args: readonly string[],
	extraEnv: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCATION_ENV.has(name))),
		...extraEnv,
	};
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", dir, ...args],
			{ env, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_PATCH_BYTES + 1024, windowsHide: true, encoding: "buffer" },
			(error, stdout) => resolve({ ok: error === null, stdout }),
		);
	});
}

/** Where an import keeps a move's working-tree payload: `<sessionDir>/.move-state/tree/<file>.<moveId>`. */
export function movedTreeDir(sessionFile: string, moveId: string): string {
	return join(dirname(sessionFile), ".move-state", "tree", `${basename(sessionFile, ".jsonl")}.${moveId}`);
}

export type HeadCheck =
	| { readonly ok: true; readonly head: string }
	| {
			readonly ok: false;
			readonly code: "not_a_repository" | "no_remote" | "head_not_pushed";
			readonly detail: string;
	  };

/** The repository's top folder: patches are made and applied there, whatever subfolder the session works in. */
async function topLevel(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return result.ok ? text(result) : undefined;
}

/** Uses the remote-tracking refs this checkout already has; it does not reach the network. */
export async function checkHeadOnRemote(cwd: string): Promise<HeadCheck> {
	const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
	if (!head.ok)
		return {
			ok: false,
			code: "not_a_repository",
			detail: `${cwd} is not a git checkout with a commit, so the other device cannot check out the same files. Move from a checkout of the repository.`,
		};
	const remotes = await git(cwd, ["remote"]);
	if (text(remotes) === "")
		return {
			ok: false,
			code: "no_remote",
			detail: `${cwd} has no remote, so the other device cannot get this repository. Add a remote and push, then move again.`,
		};
	const containing = await git(cwd, ["for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/remotes"]);
	if (text(containing) === "")
		return {
			ok: false,
			code: "head_not_pushed",
			detail:
				"Your last commit is not on a remote yet, so the other device cannot check it out. Push it, then move again.",
		};
	return { ok: true, head: text(head) };
}

/**
 * Writes the uncommitted changes (staged, unstaged and untracked, ignored files excluded) as a binary patch against
 * HEAD into `outDir`, through a throwaway index so the user's own index is never touched.
 */
export async function captureWorkingTree(
	cwd: string,
	outDir: string,
): Promise<{ readonly head: string; readonly changed: boolean }> {
	const root = await topLevel(cwd);
	if (root === undefined) throw new Error(`${cwd} is not a git checkout, so its changes cannot travel.`);
	const head = text(await git(root, ["rev-parse", "--verify", "HEAD"]));
	const scratch = await mkdtemp(join(tmpdir(), "senpi-move-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		// A failed step would leave a partial patch that looks complete: refuse instead.
		for (const step of [
			["read-tree", "HEAD"],
			["add", "-A"],
		])
			if (!(await git(root, step, env)).ok)
				throw new Error(
					`Could not read the uncommitted changes in ${root}. Commit and push them, then move again.`,
				);
		const diff = await git(root, ["diff", "--cached", "--binary", "HEAD"], env);
		if (!diff.ok) throw new Error(`Could not read the uncommitted changes in ${root}.`);
		if (diff.stdout.byteLength > MAX_PATCH_BYTES)
			throw new Error(
				`The uncommitted changes in ${cwd} are larger than ${MAX_PATCH_BYTES / 1024 / 1024} MB. Commit and push them, then move again.`,
			);
		await mkdir(outDir, { recursive: true });
		await writeFile(join(outDir, HEAD_FILE), `${head}\n`);
		if (diff.stdout.byteLength > 0) await writeFile(join(outDir, PATCH_FILE), diff.stdout);
		return { head, changed: diff.stdout.byteLength > 0 };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export type ApplyResult =
	| { readonly state: "applied" | "nothing" }
	| {
			readonly state: "kept";
			readonly reason: "receiver_dirty" | "head_differs" | "conflict" | "not_a_repository";
			readonly patchFile: string;
			readonly detail: string;
	  };

/**
 * Applies the moved changes only where that cannot clobber anything: a clean checkout at the sender's HEAD. Otherwise
 * the patch stays in `payloadDir` and the answer says why and what to do; the session itself has moved either way.
 */
export async function applyWorkingTree(cwd: string, payloadDir: string): Promise<ApplyResult> {
	const patchFile = join(payloadDir, PATCH_FILE);
	if (!(await pathExists(patchFile)) || (await stat(patchFile)).size === 0) return { state: "nothing" };
	const kept = (reason: Extract<ApplyResult, { state: "kept" }>["reason"], why: string): ApplyResult => ({
		state: "kept",
		reason,
		patchFile,
		detail: `${why} The uncommitted changes from the other device were not applied; they are in ${patchFile}. Apply them yourself with git apply.`,
	});
	const root = await topLevel(cwd);
	const status = root === undefined ? undefined : await git(root, ["status", "--porcelain"]);
	if (root === undefined || status === undefined || !status.ok)
		return kept("not_a_repository", `${cwd} is not a git checkout.`);
	if (text(status) !== "") return kept("receiver_dirty", `${root} has its own uncommitted changes.`);
	const headFile = join(payloadDir, HEAD_FILE);
	const want = (await pathExists(headFile)) ? (await readFile(headFile, "utf8")).trim() : "";
	if (want === "") return kept("head_differs", "The moved changes do not name the commit they were made on.");
	const have = text(await git(root, ["rev-parse", "--verify", "HEAD"]));
	if (have !== want)
		return kept("head_differs", `${root} is at another commit than the other device (${want.slice(0, 10)}).`);
	// From the top folder: a subfolder apply would skip every change outside it and still succeed.
	const applied = await git(root, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
	return applied.ok ? { state: "applied" } : kept("conflict", "Some of the changes did not apply cleanly.");
}
