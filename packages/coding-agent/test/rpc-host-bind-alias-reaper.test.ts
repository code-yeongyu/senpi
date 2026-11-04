import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reapOrphanedBindAliasesIn } from "../src/modes/rpc/host-bind-alias-reaper.ts";
import { readProcessStartTime } from "../src/utils/process-identity.ts";

const OLD = new Date(Date.now() - 10 * 60_000);
const DEAD_PID = 2_147_483_000;

describe("reapOrphanedBindAliasesIn (senpi#5404 review LOW 3)", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "alias-reaper-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	type Owner = { readonly pid: number; readonly processStartTime: string };
	const deadOwner: Owner = { pid: DEAD_PID, processStartTime: "Thu Jan  1 00:00:00 1970" };
	async function liveOwner(): Promise<Owner> {
		const processStartTime = await readProcessStartTime(process.pid);
		if (processStartTime === undefined) throw new Error("cannot read this test process's start time");
		return { pid: process.pid, processStartTime };
	}

	async function alias(name: string, target: string, owner: Owner, options: { readonly old?: boolean } = {}) {
		const dir = join(root, name);
		await mkdir(dir, { mode: 0o700 });
		await writeFile(join(dir, ".owner"), JSON.stringify({ ...owner, createdAt: OLD.getTime() }));
		await symlink(target, join(dir, "d"));
		if (options.old !== false) await utimes(dir, OLD, OLD);
		return dir;
	}

	it("removes an old alias whose owner is provably dead (a SIGKILLed host's leftover)", async () => {
		await alias("senpi-bind-AbC123", join(root, "gone.bind-0011"), deadOwner);
		await reapOrphanedBindAliasesIn(root);
		expect(await readdir(root)).toEqual([]);
	});

	it("keeps a live host's alias even when its bind directory was moved away", async () => {
		await alias("senpi-bind-LiVe12", join(root, "moved.bind-0022"), await liveOwner());
		await reapOrphanedBindAliasesIn(root);
		expect(await readdir(root)).toEqual(["senpi-bind-LiVe12"]);
	});

	it("keeps a young alias even when its owner is dead", async () => {
		await alias("senpi-bind-YoUnG1", join(root, "gone.bind-0033"), deadOwner, { old: false });
		await reapOrphanedBindAliasesIn(root);
		expect(await readdir(root)).toEqual(["senpi-bind-YoUnG1"]);
	});

	it("keeps anything that is not exactly an alias: another name, no owner record, extra entries, a plain file", async () => {
		await alias("senpi-bind-toolong7", join(root, "gone-a"), deadOwner);
		const noOwner = join(root, "senpi-bind-NoOwN1");
		await mkdir(noOwner, { mode: 0o700 });
		await symlink(join(root, "gone-c"), join(noOwner, "d"));
		await utimes(noOwner, OLD, OLD);
		const extra = await alias("senpi-bind-ExTra1", join(root, "gone-b"), deadOwner);
		await writeFile(join(extra, "other"), "x");
		await utimes(extra, OLD, OLD);
		await writeFile(join(root, "senpi-bind-FiLe12"), "x");
		await reapOrphanedBindAliasesIn(root);
		expect((await readdir(root)).sort()).toEqual([
			"senpi-bind-ExTra1",
			"senpi-bind-FiLe12",
			"senpi-bind-NoOwN1",
			"senpi-bind-toolong7",
		]);
	});

	it("removes the alias link itself and never what it points at", async () => {
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "keep"), "x");
		await writeFile(join(outside, "s"), "x");
		await alias("senpi-bind-NoFoL1", outside, deadOwner);
		await reapOrphanedBindAliasesIn(root);
		expect(await readdir(root)).toEqual(["outside"]);
		expect((await readdir(outside)).sort()).toEqual(["keep", "s"]);
	});
});
