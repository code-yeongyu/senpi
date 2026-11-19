import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";

const GITDIR_POINTER = /^gitdir:\s*(.+)$/;

async function readFirstLine(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf-8")).split(/\r?\n/, 1)[0]?.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function realPathOf(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function entryKind(path: string): Promise<"directory" | "file" | undefined> {
	try {
		const stats = await stat(path);
		if (stats.isDirectory()) return "directory";
		return stats.isFile() ? "file" : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The folder of the repository's main checkout that matches `cwd` inside a linked git worktree, or
 * undefined when `cwd` is not inside one. A linked worktree is the same repository as its main
 * checkout, but tools that run one agent per worktree (Orca's `~/orca/workspaces/<repo>/<name>`)
 * put it outside the main checkout, where no saved decision covers it. Reads the files
 * `git worktree add` writes, asynchronously, and never spawns git. Accepted only when the admin dir
 * points back at this `.git` file and the common dir is the main checkout's own `.git` directory;
 * bare repositories, `--separate-git-dir` clones and submodules have no main checkout to inherit from.
 * As in git, a worktree folder deleted without `git worktree prune` keeps its admin record, so a folder
 * recreated at that path with a `.git` file the record points back at is that worktree again.
 */
export async function linkedWorktreeMainCheckoutDir(cwd: string): Promise<string | undefined> {
	const dir = (await realPathOf(resolvePath(cwd))) ?? resolvePath(cwd);
	let checkoutRoot = dir;
	let markerKind = await entryKind(join(checkoutRoot, ".git"));
	while (markerKind === undefined) {
		const parentDir = dirname(checkoutRoot);
		if (parentDir === checkoutRoot) return undefined;
		checkoutRoot = parentDir;
		markerKind = await entryKind(join(checkoutRoot, ".git"));
	}
	if (markerKind !== "file") return undefined;
	const marker = join(checkoutRoot, ".git");
	const adminTarget = GITDIR_POINTER.exec((await readFirstLine(marker)) ?? "")?.[1]?.trim();
	if (!adminTarget) return undefined;
	// Every pointer is resolved against the admin dir's real path, so relative pointers (`git worktree add
	// --relative-paths`) and the location check below all speak about the same directory.
	const adminDir = await realPathOf(resolve(checkoutRoot, adminTarget));
	if (adminDir === undefined) return undefined;
	const commonDirPointer = await readFirstLine(join(adminDir, "commondir"));
	const backPointer = await readFirstLine(join(adminDir, "gitdir"));
	if (commonDirPointer === undefined || backPointer === undefined) return undefined;
	const markerRealPath = await realPathOf(marker);
	if (markerRealPath === undefined || (await realPathOf(resolve(adminDir, backPointer))) !== markerRealPath) {
		return undefined;
	}
	const commonDir = await realPathOf(resolve(adminDir, commonDirPointer));
	if (commonDir === undefined || basename(commonDir) !== ".git") return undefined;
	// The pointers above only agree with each other; a folder that is not this repository's worktree can carry its own
	// consistent set. Git keeps a linked worktree's admin dir in `<common dir>/worktrees/`, inside the repository.
	if (dirname(adminDir) !== join(commonDir, "worktrees")) return undefined;
	const mainCheckout = dirname(commonDir);
	const mainMarker = join(mainCheckout, ".git");
	if ((await entryKind(mainMarker)) !== "directory" || (await realPathOf(mainMarker)) !== commonDir) return undefined;
	return join(mainCheckout, relative(checkoutRoot, dir));
}
