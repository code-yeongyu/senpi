/**
 * senpi#6435: the identity a caller reads before the release and the one the bundle carries are read at two times.
 * `identity` answers what the session recorded when it was asked; `export` reads the session again, after the release.
 * A session that records another repository in between passes `prepare` and is refused by the import, after the
 * release. This pins what that costs today: nothing lands, the move is declined, and the sender takes the session back.
 */
import { appendFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE } from "../../src/core/repository-identity.ts";
import { getDefaultSessionDir, loadEntriesFromFile } from "../../src/core/session-manager.ts";
import { sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move } from "./rpc-move-session-support.ts";

const MOVE = "move-gap-1";
const writable = (file: string) => sessionOwnership(loadEntriesFromFile(file)).writable;

describe("a session that records another repository after its identity was read (senpi#6435)", () => {
	it("#given a move readied with the identity read before the release #when the session then records another repository and is released, exported and imported #then the import is refused after the release, nothing lands, and the sender takes the session back", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const identity = await move(a, { op: "identity", sessionPath: fixture.sessionPath });
		const repository = (identity.data as { repository?: unknown }).repository;
		expect(await move(b, { op: "prepare", moveId: MOVE, cwd: fixture.repoB, repository })).toMatchObject({
			success: true,
		});
		const recordedLater = {
			type: "custom",
			id: "r2",
			parentId: "u1",
			timestamp: "2026-10-19T00:00:02.000Z",
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: { rootCommits: ["f".repeat(40)] },
		};
		appendFileSync(fixture.sessionPath, `${JSON.stringify(recordedLater)}\n`);
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, MOVE);
		const sent = await move(a, { op: "export", sessionPath: fixture.sessionPath, moveId: MOVE, target: "device-b" });
		const bundleDir = (sent.data as { bundle_dir: string }).bundle_dir;

		const refused = await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" });

		expect(refused).toMatchObject({ success: false, errorCode: "move_repository_mismatch" });
		const landing = join(getDefaultSessionDir(fixture.repoB, fixture.agentB), basename(fixture.sessionPath));
		expect(existsSync(landing)).toBe(false);
		const answer = (await move(b, { op: "status", moveId: MOVE })).data;
		expect(answer).toEqual({ state: "declined", reason: "repository" });
		expect(writable(fixture.sessionPath)).toBe(false);
		await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: MOVE, answer });
		expect(writable(fixture.sessionPath)).toBe(true);
	});
});
