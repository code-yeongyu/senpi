/**
 * A move the receiver already accepted lands once (senpi#4004): importing its bundle again into another folder is
 * fenced whether or not the import was revoked, so a second writable copy never appears. Re-importing into the same
 * file stays an idempotent no-op.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, importedOnB, move } from "./rpc-move-session-support.ts";

describe("move_session import of an already accepted move (senpi#4004)", () => {
	for (const revoked of [true, false]) {
		it(`#given B accepted the move${revoked ? " and revoked it" : ""} #when the bundle is imported into another folder #then it is fenced and lands nothing`, async () => {
			const fixture = await devices();
			await using a = createInProcessRig(fixture.agentA);
			await using b = createInProcessRig(fixture.agentB);
			const moveId = revoked ? "move-i1" : "move-i2";
			const onB = await importedOnB(a, b, fixture, moveId);
			if (revoked) await move(b, { op: "revoke", sessionPath: onB, moveId });
			const bundleDir = join(fixture.agentA, "session-moves", "outgoing", moveId);
			const elsewhere = join(getDefaultSessionDir(fixture.repoA, fixture.agentB), basename(onB));

			expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoA, from: "device-a" })).toMatchObject({
				success: false,
				error: "move_fenced",
			});
			expect(existsSync(elsewhere)).toBe(false);
			expect((await move(b, { op: "status", moveId })).data).toEqual(
				revoked ? { state: "accepted", revoked: true } : { state: "accepted" },
			);

			expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" })).toMatchObject({
				success: true,
				data: { session_path: onB },
			});
		});
	}
});
