// The scratch copy EQ mutations run in (plan P0-05d): a clone of the source tree at its HEAD plus its ignored
// dependencies and build output, so a mutation patch is applied, run and reverted without ever touching the working tree.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Ignored paths of the source tree the scratch copy needs (dependencies, build output, generated sources), minus run
 * output: QA evidence, Rust targets, logs.
 */
const NOT_COPIED = [/^local-ignore(\/|$)/, /(^|\/)target\/$/, /^\.artifacts\//, /\.log$/, /(^|\/)\.DS_Store$/];

/** Ignored entries (as `git ls-files --others --ignored --exclude-standard --directory` lists them) to copy. */
export const entriesToCopy = (entries) => entries.filter((e) => e && !NOT_COPIED.some((re) => re.test(e)));

const git = (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr.trim()}`);
	return r.stdout;
};
const gitOk = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" }).status === 0;

/** `git status --porcelain` of a tree (ignored files are not listed). */
export const porcelain = (dir) => git(dir, ["status", "--porcelain", "--untracked-files=all"]);

/**
 * A scratch copy of `source` at its HEAD: a shared clone checked out detached at the same commit, plus copies of the
 * ignored dependencies and build output. Symlinks are copied as they are (relative workspace links keep resolving
 * inside the copy) and files are cloned copy-on-write where the filesystem can. The source must be clean, so the
 * scratch is exactly the committed tree; it is clean itself when this returns.
 */
export function makeScratch(source, scratchRoot) {
	const dirty = porcelain(source);
	if (dirty) throw new Error(`the source tree is not clean; commit first:\n${dirty}`);
	const head = headOf(source);
	const root = mkdtempSync(join(scratchRoot, "eq-mutations-"));
	const dir = join(root, "senpi");
	try {
		git(root, ["clone", "--quiet", "--shared", "--no-checkout", source, dir]);
		git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", head]);
		const listed = git(source, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
		const copied = entriesToCopy(listed.split("\0"));
		for (const entry of copied)
			cpSync(join(source, entry), join(dir, entry), {
				recursive: true,
				verbatimSymlinks: true,
				mode: constants.COPYFILE_FICLONE,
			});
		const after = porcelain(dir);
		if (after) throw new Error(`the scratch copy is not clean after the copy:\n${after}`);
		return { root, dir, head, copied: copied.length, remove: () => rmSync(root, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

/** HEAD of a tree. */
export const headOf = (dir) => git(dir, ["rev-parse", "HEAD"]).trim();

/** Whether a patch applies to a tree (`git apply --check` reads the tree, never writes it). */
export const patchApplies = (dir, patchFile) => gitOk(dir, ["apply", "--check", patchFile]);

/** Apply a patch in the scratch; returns the files it changed. A patch that no longer applies is STALE. */
export function applyPatch(dir, patchFile) {
	if (!patchApplies(dir, patchFile)) return { applied: false, files: [] };
	git(dir, ["apply", patchFile]);
	return { applied: true, files: git(dir, ["diff", "--name-only"]).trim().split("\n").filter(Boolean) };
}

/** Revert an applied patch and report whether the tree is clean and the patch still applies. */
export function revertPatch(dir, patchFile) {
	const reversed = gitOk(dir, ["apply", "-R", patchFile]);
	const clean = reversed && porcelain(dir) === "";
	return { clean, reapplies: clean && patchApplies(dir, patchFile) };
}

/** sha256 of a patch file, for the receipt. */
export const patchSha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
