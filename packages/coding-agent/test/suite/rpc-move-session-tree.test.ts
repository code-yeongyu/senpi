/**
 * `move_session` with a working tree (senpi#3676): `precheck` gates an offer on the sender's HEAD being on a remote,
 * `export` carries the uncommitted changes, and `import` applies them to the receiver's clean checkout at that HEAD.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE } from "../../src/core/repository-identity.ts";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { hostAndRelease, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function devicesWithRemote() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "senpi-rpc-move-tree-")));
	dirs.push(base);
	const origin = join(base, "origin.git");
	git(base, "init", "-q", "--bare", origin);
	const repoA = join(base, "a", "repo");
	git(base, "clone", "-q", origin, repoA);
	writeFileSync(join(repoA, "tracked.txt"), "one\n");
	git(repoA, "add", "tracked.txt");
	git(repoA, "commit", "-q", "-m", "root");
	git(repoA, "push", "-q", "origin", "HEAD");
	const repoB = join(base, "b", "repo");
	git(base, "clone", "-q", origin, repoB);
	const root = git(repoA, "rev-list", "--max-parents=0", "HEAD");
	const agentA = join(base, "agent-a");
	const agentB = join(base, "agent-b");
	const sessionPath = join(getDefaultSessionDir(repoA, agentA), `2026-10-19T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-19T00:00:00.000Z", cwd: repoA },
		{
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-10-19T00:00:00.500Z",
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: { rootCommits: [root] },
		},
	];
	writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return { repoA, repoB, agentA, agentB, sessionPath };
}

describe("move_session with a working tree (senpi#3676)", () => {
	it("#given uncommitted changes at A #then they arrive applied in B's clean checkout at the same HEAD", async () => {
		const { repoA, repoB, agentA, agentB, sessionPath } = devicesWithRemote();
		writeFileSync(join(repoA, "tracked.txt"), "one\nedited on A\n");
		writeFileSync(join(repoA, "new.txt"), "brand new\n");
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);

		expect(await move(a, { op: "precheck", sessionPath })).toMatchObject({
			success: true,
			data: { head: git(repoA, "rev-parse", "HEAD") },
		});
		await move(b, { op: "prepare", moveId: "move-t1" });
		await hostAndRelease(a, repoA, sessionPath, "move-t1");
		const exported = await move(a, { op: "export", sessionPath, moveId: "move-t1", target: "device-b" });
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;

		expect(await move(b, { op: "import", bundleDir, cwd: repoB })).toMatchObject({
			success: true,
			data: { working_tree: { state: "applied" } },
		});
		expect(readFileSync(join(repoB, "tracked.txt"), "utf8")).toBe("one\nedited on A\n");
		expect(readFileSync(join(repoB, "new.txt"), "utf8")).toBe("brand new\n");
		expect(git(repoA, "status", "--porcelain")).toContain("?? new.txt");
	});

	it("#given a commit at A that is not pushed #then precheck refuses with a reason and an action", async () => {
		const { repoA, agentA, sessionPath } = devicesWithRemote();
		writeFileSync(join(repoA, "tracked.txt"), "two\n");
		git(repoA, "commit", "-q", "-am", "local");
		await using a = createInProcessRig(agentA);

		expect(await move(a, { op: "precheck", sessionPath })).toMatchObject({
			success: false,
			error: "head_not_pushed",
			errorData: { detail: expect.stringMatching(/push/i) },
		});
	});

	it("#given B has its own uncommitted changes #then the session moves and the patch is kept with what to do", async () => {
		const { repoA, repoB, agentA, agentB, sessionPath } = devicesWithRemote();
		writeFileSync(join(repoA, "tracked.txt"), "one\nedited on A\n");
		writeFileSync(join(repoB, "tracked.txt"), "local on B\n");
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);
		await move(b, { op: "prepare", moveId: "move-t2" });
		await hostAndRelease(a, repoA, sessionPath, "move-t2");
		const exported = await move(a, { op: "export", sessionPath, moveId: "move-t2", target: "device-b" });

		const imported = await move(b, {
			op: "import",
			bundleDir: (exported.data as { bundle_dir: string }).bundle_dir,
			cwd: repoB,
		});
		expect(imported).toMatchObject({
			success: true,
			data: {
				session_id: SESSION_ID,
				working_tree: { state: "kept", reason: "receiver_dirty", patch_file: expect.any(String) },
			},
		});
		const patchFile = (imported.data as { working_tree: { patch_file: string } }).working_tree.patch_file;
		expect(readFileSync(patchFile, "utf8")).toContain("edited on A");
		expect(readFileSync(join(repoB, "tracked.txt"), "utf8")).toBe("local on B\n");
	});
});
