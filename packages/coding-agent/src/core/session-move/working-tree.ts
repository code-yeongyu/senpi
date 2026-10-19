import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * The working folder a moved session leaves behind (senpi#3676, design v7 section 6). The receiver uses its own checkout
 * of the same repository, so only what git cannot fetch travels: the uncommitted changes, as one binary patch against
 * the sender's HEAD. The sender first checks that HEAD is on a remote, so the receiver can have the same commit.
 */
export const WORKING_TREE_PAYLOAD = "working-tree";
export const PATCH_FILE = "changes.patch";
export const HEAD_FILE = "head";
/** A patch larger than this is refused rather than carried: the move is for a session, not for a folder. */
export const MAX_PATCH_BYTES = 64 * 1024 * 1024;

const GIT_TIMEOUT_MS = 30_000;
// An inherited repository location would point every command at that one repository.
const GIT_LOCATION_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]);

interface GitResult {
	readonly ok: boolean;
	readonly stdout: string;
}

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
			(error, stdout) => resolve({ ok: error === null, stdout: stdout.toString("latin1") }),
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
	if (remotes.stdout.trim() === "")
		return {
			ok: false,
			code: "no_remote",
			detail: `${cwd} has no remote, so the other device cannot get this repository. Add a remote and push, then move again.`,
		};
	const containing = await git(cwd, ["for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/remotes"]);
	if (containing.stdout.trim() === "")
		return {
			ok: false,
			code: "head_not_pushed",
			detail:
				"Your last commit is not on a remote yet, so the other device cannot check it out. Push it, then move again.",
		};
	return { ok: true, head: head.stdout.trim() };
}

/**
 * Writes the uncommitted changes (staged, unstaged and untracked, ignored files excluded) as a binary patch against
 * HEAD into `outDir`, through a throwaway index so the user's own index is never touched.
 */
export async function captureWorkingTree(
	cwd: string,
	outDir: string,
): Promise<{ readonly head: string; readonly changed: boolean }> {
	const head = (await git(cwd, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
	const scratch = mkdtempSync(join(tmpdir(), "senpi-move-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		await git(cwd, ["read-tree", "HEAD"], env);
		await git(cwd, ["add", "-A"], env);
		const diff = await git(cwd, ["diff", "--cached", "--binary", "HEAD"], env);
		if (!diff.ok) throw new Error(`Could not read the uncommitted changes in ${cwd}.`);
		if (Buffer.byteLength(diff.stdout, "latin1") > MAX_PATCH_BYTES)
			throw new Error(
				`The uncommitted changes in ${cwd} are larger than ${MAX_PATCH_BYTES / 1024 / 1024} MB. Commit and push them, then move again.`,
			);
		mkdirSync(outDir, { recursive: true });
		writeFileSync(join(outDir, HEAD_FILE), `${head}\n`);
		if (diff.stdout !== "") writeFileSync(join(outDir, PATCH_FILE), Buffer.from(diff.stdout, "latin1"));
		return { head, changed: diff.stdout !== "" };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export type ApplyResult =
	| { readonly state: "applied" | "nothing" }
	| {
			readonly state: "kept";
			readonly reason: "receiver_dirty" | "head_differs" | "conflict";
			readonly patchFile: string;
			readonly detail: string;
	  };

/**
 * Applies the moved changes only where that cannot clobber anything: a clean checkout at the sender's HEAD. Otherwise
 * the patch stays in `payloadDir` and the answer says why and what to do; the session itself has moved either way.
 */
export async function applyWorkingTree(cwd: string, payloadDir: string): Promise<ApplyResult> {
	const patchFile = join(payloadDir, PATCH_FILE);
	if (!existsSync(patchFile) || statSync(patchFile).size === 0) return { state: "nothing" };
	const kept = (reason: "receiver_dirty" | "head_differs" | "conflict", why: string): ApplyResult => ({
		state: "kept",
		reason,
		patchFile,
		detail: `${why} The uncommitted changes from the other device were not applied; they are in ${patchFile}. Apply them yourself with git apply.`,
	});
	const status = await git(cwd, ["status", "--porcelain"]);
	if (!status.ok || status.stdout.trim() !== "")
		return kept("receiver_dirty", `${cwd} has its own uncommitted changes.`);
	const want = readFileSync(join(payloadDir, HEAD_FILE), "utf8").trim();
	const have = (await git(cwd, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
	if (have !== want)
		return kept("head_differs", `${cwd} is at another commit than the other device (${want.slice(0, 10)}).`);
	const applied = await git(cwd, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
	return applied.ok ? { state: "applied" } : kept("conflict", "Some of the changes did not apply cleanly.");
}
