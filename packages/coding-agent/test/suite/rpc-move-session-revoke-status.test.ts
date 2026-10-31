/**
 * `move_session` op `status` after a revoke (senpi#4004): the receiver's ledger record stays `accepted` and carries
 * `revoked: true`, so the sender hears the revoke with or without the imported copy's path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, importedOnB, move } from "./rpc-move-session-support.ts";

describe("move_session status after a revoke (senpi#4004)", () => {
	it("#given B revoked its import #when status asks without sessionPath #then it answers accepted + revoked and finish takes the session back", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-s1");
		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-s1" })).toMatchObject({ success: true });

		const answer = (await move(b, { op: "status", moveId: "move-s1" })).data;
		expect(answer).toEqual({ state: "accepted", revoked: true });
		const ledgerRecord = JSON.parse(
			readFileSync(join(fixture.agentB, "session-moves", "ledger", "move-s1.json"), "utf8"),
		) as Record<string, unknown>;
		expect(ledgerRecord).toMatchObject({ state: "accepted", revoked: true });

		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-s1");
		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" })).toMatchObject({
			success: true,
		});
		expect((await move(b, { op: "status", moveId: "move-s1" })).data).toEqual({ state: "accepted", revoked: true });

		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-s1", answer }),
		).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(customTypes(fixture.sessionPath)).toEqual(["session_released", "session_reclaimed"]);
	});

	it("#given a sessionPath that is not this move's import #then status refuses move_mismatch; a path with no file answers from the ledger", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-s2");

		expect(await move(b, { op: "status", moveId: "move-s2", sessionPath: fixture.sessionPath })).toMatchObject({
			success: false,
			error: "move_mismatch",
			errorData: { detail: expect.any(String) },
		});
		expect(await move(b, { op: "status", moveId: "move-s2", sessionPath: `${onB}.missing` })).toMatchObject({
			success: true,
			data: { state: "accepted" },
		});
	});
});
