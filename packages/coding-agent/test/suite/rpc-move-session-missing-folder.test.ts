/**
 * A move into a folder that does not exist on the receiving device. Only the receiver can tell a
 * missing folder from a folder that holds another repository, so `prepare` and `import` refuse it with its own code,
 * `workspace_missing`, the code a client already reads for a session whose folder is gone. A folder that exists and
 * holds another repository is still `move_repository_mismatch`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move, unrelatedRepo } from "./rpc-move-session-support.ts";

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);

describe("move_session into a folder missing on the receiver", () => {
	it("#given a prepare that names a folder missing on the receiver #then it is refused workspace_missing and no move is readied", async () => {
		const fixture = await devices();
		const gone = join(fixture.base, "gone", "repo");
		await using b = createInProcessRig(fixture.agentB);

		const refused = await move(b, {
			op: "prepare",
			moveId: "move-m1",
			cwd: gone,
			repository: { rootCommits: [fixture.root] },
		});

		expect(refused).toMatchObject({
			success: false,
			errorCode: "workspace_missing",
			errorData: { detail: expect.stringContaining(gone) },
		});
		expect(existsSync(ledgerFile(fixture.agentB, "move-m1"))).toBe(false);
	});

	it("#given a released move readied with no folder #when it is imported into a folder missing on the receiver #then it is refused workspace_missing, nothing lands, and the move is declined so the sender takes the session back", async () => {
		const fixture = await devices();
		const gone = join(fixture.base, "gone", "repo");
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await move(b, { op: "prepare", moveId: "move-m2" });
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-m2");
		const exported = await move(a, {
			op: "export",
			sessionPath: fixture.sessionPath,
			moveId: "move-m2",
			target: "device-b",
		});
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;

		const refused = await move(b, { op: "import", bundleDir, cwd: gone, from: "device-a" });

		expect(refused).toMatchObject({
			success: false,
			errorCode: "workspace_missing",
			errorData: { detail: expect.stringContaining(gone) },
		});
		expect(existsSync(gone)).toBe(false);
		// Declined as the repository check declines a move: the record a sender settles from, as for a mismatch.
		expect((await move(b, { op: "status", moveId: "move-m2" })).data).toEqual({
			state: "declined",
			reason: "repository",
		});
	});

	it("#given a prepare that names an existing folder holding another repository #then it is still refused move_repository_mismatch", async () => {
		const fixture = await devices();
		const other = unrelatedRepo(join(fixture.base, "other"));
		await using b = createInProcessRig(fixture.agentB);

		expect(
			await move(b, { op: "prepare", moveId: "move-m3", cwd: other, repository: { rootCommits: [fixture.root] } }),
		).toMatchObject({ success: false, errorCode: "move_repository_mismatch" });
	});
});
