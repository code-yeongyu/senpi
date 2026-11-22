// senpi#5645 (S40 PR 2, design v2.4): a hand's `run` takes the memory component's git-activity lock as that component
// does. Only EWOULDBLOCK/EAGAIN is busy; ENOLCK, EOPNOTSUPP and ENOSYS mean no hold; any other errno is a failure. The
// lock is opened only when its directory exists, so a late git run never recreates a removed identity tree.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Flock, holdActivityLock } from "../../src/modes/rpc/hand-activity-lock.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function identityRepo(withLocksDir = true): Promise<{ readonly repo: string; readonly locks: string }> {
	const root = await mkdtemp(join(tmpdir(), "senpi-activity-"));
	dirs.push(root);
	const repo = join(root, "agents", "a1", "repo");
	const locks = join(root, "agents", "a1", "runtime", "locks");
	await mkdir(repo, { recursive: true });
	if (withLocksDir) await mkdir(locks, { recursive: true });
	return { repo, locks };
}

const failing =
	(...errnos: number[]): Flock =>
	() => {
		const errno = errnos.shift();
		return errno === undefined ? { rc: 0, errno: 0 } : { rc: -1, errno };
	};

describe("the hand's git-activity lock (senpi#5645, design v2.4)", () => {
	it("retries a busy lock and holds it once it is free", async () => {
		const { repo } = await identityRepo();

		const hold = await holdActivityLock(repo, failing(constants.errno.EAGAIN, constants.errno.EWOULDBLOCK));

		expect(hold.fd).toBeTypeOf("number");
		await hold.release();
	});

	it.each([
		["ENOLCK", constants.errno.ENOLCK],
		["EOPNOTSUPP", constants.errno.EOPNOTSUPP],
		["ENOSYS", constants.errno.ENOSYS],
	])("falls back to no hold on %s", async (_name, errno) => {
		const { repo } = await identityRepo();

		const hold = await holdActivityLock(repo, failing(errno));

		expect(hold.fd).toBeUndefined();
	});

	it("refuses any other errno instead of treating it as no hold", async () => {
		const { repo } = await identityRepo();

		await expect(holdActivityLock(repo, failing(constants.errno.EBADF))).rejects.toMatchObject({ code: "io" });
	});

	it("gives up after its bound while the lock stays busy", async () => {
		const { repo } = await identityRepo();
		const alwaysBusy: Flock = () => ({ rc: -1, errno: constants.errno.EAGAIN });

		await expect(holdActivityLock(repo, alwaysBusy, 20)).rejects.toMatchObject({ code: "io" });
	});

	it("refuses when the locks directory is gone and does not recreate it", async () => {
		const { repo, locks } = await identityRepo(false);

		await expect(holdActivityLock(repo, failing())).rejects.toMatchObject({ code: "not_found" });
		expect(existsSync(locks)).toBe(false);
	});

	it("holds nothing outside an identity repository, or without flock", async () => {
		const outside = await mkdtemp(join(tmpdir(), "senpi-activity-other-"));
		dirs.push(outside);
		const { repo } = await identityRepo();

		expect((await holdActivityLock(outside, failing())).fd).toBeUndefined();
		expect((await holdActivityLock(repo, undefined)).fd).toBeUndefined();
	});
});
