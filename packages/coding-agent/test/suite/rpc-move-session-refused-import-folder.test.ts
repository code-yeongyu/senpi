/**
 * A refused import leaves nothing behind (senpi#6565). `import` picks its session folder before it reaches the fence,
 * and picking the default one creates it, so an import refused `move_fenced` leaves an empty session folder for the
 * folder it named. The folder is named here with the path-only helper: the helper that creates it would make this row
 * blind.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getDefaultSessionDirPath } from "../../src/core/session-manager.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move } from "./rpc-move-session-support.ts";

// senpi#6565
it("#given a move readied for one folder #when its bundle is imported into another folder and refused #then no session folder is left behind for that other folder", async () => {
	const fixture = await devices();
	await using a = createInProcessRig(fixture.agentA);
	await using b = createInProcessRig(fixture.agentB);
	const elsewhere = join(fixture.base, "elsewhere");
	mkdirSync(elsewhere);
	const folder = getDefaultSessionDirPath(elsewhere, fixture.agentB);
	await move(b, { op: "prepare", moveId: "move-f1", cwd: fixture.repoB, repository: { rootCommits: [fixture.root] } });
	await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-f1");
	const bundle = await move(a, {
		op: "export",
		sessionPath: fixture.sessionPath,
		moveId: "move-f1",
		target: "device-b",
	});
	expect(existsSync(folder)).toBe(false);

	const refused = await move(b, {
		op: "import",
		cwd: elsewhere,
		bundleDir: (bundle.data as { bundle_dir: string }).bundle_dir,
	});

	expect(refused).toMatchObject({ success: false, command: "move_session", errorCode: "move_fenced" });
	expect(existsSync(folder)).toBe(false);
});
