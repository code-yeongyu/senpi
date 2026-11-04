import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reapOrphanedBindAliasesIn } from "../src/modes/rpc/host-bind-alias-reaper.ts";

const OLD = new Date(Date.now() - 10 * 60_000);

describe("reapOrphanedBindAliasesIn (senpi#5404 review LOW 3)", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "alias-reaper-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function alias(name: string, target: string, options: { readonly old?: boolean } = {}): Promise<string> {
		const dir = join(root, name);
		await mkdir(dir, { mode: 0o700 });
		await symlink(target, join(dir, "d"));
		if (options.old !== false) await utimes(dir, OLD, OLD);
		return dir;
	}

	it("removes an old alias whose bind directory is gone (a SIGKILLed host's leftover)", async () => {
		await alias("senpi-bind-AbC123", join(root, "gone.bind-0011"));
		await reapOrphanedBindAliasesIn(root);
		expect(await readdir(root)).toEqual([]);
	});

	it("keeps an alias whose bind directory still exists (a live host, or one gc has not reclaimed yet)", async () => {
		const bindDir = join(root, "live.bind-0022");
		await mkdir(bindDir, { mode: 0o700 });
		await alias("senpi-bind-LiVe12", bindDir);
		await reapOrphanedBindAliasesIn(root);
		expect((await readdir(root)).sort()).toEqual(["live.bind-0022", "senpi-bind-LiVe12"]);
	});

	it("keeps a young alias even when its target is gone", async () => {
		await alias("senpi-bind-YoUnG1", join(root, "gone.bind-0033"), { old: false });
		await reapOrphanedBindAliasesIn(root);
		expect(await readdir(root)).toEqual(["senpi-bind-YoUnG1"]);
	});

	it("keeps anything that is not exactly an alias: another name, extra entries, or a plain file", async () => {
		await alias("senpi-bind-toolong7", join(root, "gone-a"));
		const extra = await alias("senpi-bind-ExTra1", join(root, "gone-b"));
		await writeFile(join(extra, "other"), "x");
		await utimes(extra, OLD, OLD);
		await writeFile(join(root, "senpi-bind-FiLe12"), "x");
		await reapOrphanedBindAliasesIn(root);
		expect((await readdir(root)).sort()).toEqual(["senpi-bind-ExTra1", "senpi-bind-FiLe12", "senpi-bind-toolong7"]);
	});

	it("never follows the alias link when removing it", async () => {
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "keep"), "x");
		const dir = join(root, "senpi-bind-NoFoL1");
		await mkdir(dir, { mode: 0o700 });
		await symlink(join(root, "gone.bind-0044"), join(dir, "d"));
		await utimes(dir, OLD, OLD);
		await reapOrphanedBindAliasesIn(root);
		expect(await readdir(outside)).toEqual(["keep"]);
	});
});
