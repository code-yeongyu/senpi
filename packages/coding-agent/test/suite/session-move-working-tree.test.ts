/**
 * The working tree a moved session leaves behind (senpi#3676, design v7 section 6): the sender checks that its HEAD is
 * on a remote before offering a move, captures uncommitted changes (untracked files included) as a patch without
 * touching its own index, and the receiver applies that patch only to a clean checkout at the same HEAD, keeping the
 * patch file otherwise.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyWorkingTree, captureWorkingTree, checkHeadOnRemote } from "../../src/core/session-move/working-tree.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function repos() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-tree-")));
	dirs.push(base);
	const origin = join(base, "origin.git");
	git(base, "init", "-q", "--bare", origin);
	const a = join(base, "a");
	git(base, "clone", "-q", origin, a);
	writeFileSync(join(a, "tracked.txt"), "one\n");
	git(a, "add", "tracked.txt");
	git(a, "commit", "-q", "-m", "root");
	git(a, "push", "-q", "origin", "HEAD");
	const b = join(base, "b");
	git(base, "clone", "-q", origin, b);
	return { base, a, b };
}

describe("checkHeadOnRemote (senpi#3676)", () => {
	it("#given a HEAD a remote has #then the move may go ahead", async () => {
		const { a } = repos();
		expect(await checkHeadOnRemote(a)).toEqual({ ok: true, head: git(a, "rev-parse", "HEAD") });
	});

	it("#given a commit not pushed yet #then it refuses with a reason and an action", async () => {
		const { a } = repos();
		writeFileSync(join(a, "tracked.txt"), "two\n");
		git(a, "commit", "-q", "-am", "local only");
		expect(await checkHeadOnRemote(a)).toMatchObject({
			ok: false,
			code: "head_not_pushed",
			detail: expect.stringMatching(/push/i),
		});
	});

	it("#given a folder with no remote or no repository #then it refuses with its own code", async () => {
		const { base } = repos();
		const lone = join(base, "lone");
		mkdirSync(lone);
		git(lone, "init", "-q");
		writeFileSync(join(lone, "f"), "x");
		git(lone, "add", "f");
		git(lone, "commit", "-q", "-m", "x");
		expect(await checkHeadOnRemote(lone)).toMatchObject({ ok: false, code: "no_remote" });
		const plain = join(base, "plain");
		mkdirSync(plain);
		expect(await checkHeadOnRemote(plain)).toMatchObject({ ok: false, code: "not_a_repository" });
	});
});

describe("captureWorkingTree and applyWorkingTree (senpi#3676)", () => {
	it("#given tracked edits and an untracked file #then the receiver at the same clean HEAD gets both, and the sender's index is untouched", async () => {
		const { base, a, b } = repos();
		writeFileSync(join(a, "tracked.txt"), "one\nedited\n");
		writeFileSync(join(a, "new.txt"), "untracked\n");
		const indexBefore = git(a, "diff", "--cached", "--name-only");
		const out = join(base, "payload");

		const captured = await captureWorkingTree(a, out);

		expect(captured).toMatchObject({ head: git(a, "rev-parse", "HEAD"), changed: true });
		expect(git(a, "diff", "--cached", "--name-only")).toBe(indexBefore);
		expect(git(a, "status", "--porcelain")).toContain("?? new.txt");

		expect(await applyWorkingTree(b, out)).toEqual({ state: "applied" });
		expect(readFileSync(join(b, "tracked.txt"), "utf8")).toBe("one\nedited\n");
		expect(readFileSync(join(b, "new.txt"), "utf8")).toBe("untracked\n");
	});

	it("#given a clean sender #then nothing is captured and apply has nothing to do", async () => {
		const { base, a, b } = repos();
		const out = join(base, "payload");
		expect(await captureWorkingTree(a, out)).toMatchObject({ changed: false });
		expect(await applyWorkingTree(b, out)).toEqual({ state: "nothing" });
	});

	it("#given a receiver with its own uncommitted changes or another HEAD #then the patch is kept, not applied", async () => {
		const { base, a, b } = repos();
		writeFileSync(join(a, "tracked.txt"), "one\nedited\n");
		const out = join(base, "payload");
		await captureWorkingTree(a, out);

		writeFileSync(join(b, "tracked.txt"), "local edit on b\n");
		const dirty = await applyWorkingTree(b, out);
		expect(dirty).toMatchObject({ state: "kept", reason: "receiver_dirty", patchFile: expect.any(String) });
		expect(readFileSync(join(b, "tracked.txt"), "utf8")).toBe("local edit on b\n");
		expect(existsSync((dirty as { patchFile: string }).patchFile)).toBe(true);

		git(b, "checkout", "-q", "--", "tracked.txt");
		writeFileSync(join(b, "other.txt"), "x");
		git(b, "add", "other.txt");
		git(b, "commit", "-q", "-m", "b moved on");
		expect(await applyWorkingTree(b, out)).toMatchObject({ state: "kept", reason: "head_differs" });
		expect(readFileSync(join(b, "tracked.txt"), "utf8")).toBe("one\n");
	});
});
