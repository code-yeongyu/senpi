/**
 * `move_session` op `status` for an accepted move answers where it landed (senpi#6436). The import's own answer was the
 * only one that named the landed session, so a caller that lost it, and whose bundle was gone, could never bind a
 * session that had landed. The path is the target the move's record stores, read under the record's lock, and it is
 * answered only while the file there still records this move.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, importedOnB, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);

describe("move_session status answers where an accepted move landed (senpi#6436)", () => {
	it("#given a move the target imported and accepted, whose import answer the caller lost and whose bundle the source removed at finish #when the caller asks status with the move id alone #then the answer is accepted with the landed file's path, its header's id and folder, and the file is unchanged", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-p1");
		expect(
			await move(a, {
				op: "finish",
				sessionPath: fixture.sessionPath,
				moveId: "move-p1",
				answer: { state: "accepted" },
			}),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
		expect(existsSync(join(fixture.agentA, "session-moves", "outgoing", "move-p1"))).toBe(false);
		const bytes = readFileSync(onB);
		const modified = statSync(onB).mtimeMs;

		const answer = await move(b, { op: "status", moveId: "move-p1" });

		expect(answer).toMatchObject({ success: true });
		expect(answer.data).toEqual({
			state: "accepted",
			session_path: onB,
			session_id: SESSION_ID,
			cwd: fixture.repoB,
		});
		expect(readFileSync(onB)).toEqual(bytes);
		expect(statSync(onB).mtimeMs).toBe(modified);
		// The sender's finish takes the answer as it came: the fields beside `state` change nothing there.
		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-p1", answer: answer.data }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
	});

	it("#given the landed file was deleted #when the caller asks status #then it answers accepted with landed_file gone and no path", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-p2");
		rmSync(onB);

		expect((await move(b, { op: "status", moveId: "move-p2" })).data).toEqual({
			state: "accepted",
			landed_file: "gone",
		});
	});

	it("#given a file at the landed path that no longer records this move #when the caller asks status #then it answers landed_file gone and no path", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-p3");
		const header = { type: "session", version: 3, id: "another-session", timestamp: "2026-10-19T00:00:00.000Z" };
		writeFileSync(onB, `${JSON.stringify({ ...header, cwd: fixture.repoB })}\n`);

		expect((await move(b, { op: "status", moveId: "move-p3" })).data).toEqual({
			state: "accepted",
			landed_file: "gone",
		});
	});

	it("#given an import of the same move into another folder #when it is refused move_fenced #then the refusal carries the landed path, id and folder", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-p4");
		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-p4");

		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoA, from: "device-a" })).toMatchObject({
			success: false,
			error: "move_fenced",
			errorData: { detail: expect.any(String), session_path: onB, session_id: SESSION_ID, cwd: fixture.repoB },
		});
	});

	it("#given the target revoked its import #when the same move is imported again elsewhere #then the refusal says revoked beside the landed path", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-p9");
		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-p9" })).toMatchObject({ success: true });
		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-p9");

		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoA, from: "device-a" })).toMatchObject({
			success: false,
			error: "move_fenced",
			errorData: {
				detail: expect.any(String),
				session_path: onB,
				session_id: SESSION_ID,
				cwd: fixture.repoB,
				revoked: true,
			},
		});
	});

	it("#given the target revoked its import #when the caller asks status #then revoked stays beside the landed path", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-p5");
		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-p5" })).toMatchObject({ success: true });

		expect((await move(b, { op: "status", moveId: "move-p5" })).data).toEqual({
			state: "accepted",
			revoked: true,
			session_path: onB,
			session_id: SESSION_ID,
			cwd: fixture.repoB,
		});
	});

	it("#given an accepted record that stores no landing target (an older build wrote it) #when the caller asks status #then it answers accepted alone", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await importedOnB(a, b, fixture, "move-p6");
		writeFileSync(ledgerFile(fixture.agentB, "move-p6"), `${JSON.stringify({ state: "accepted" })}\n`);

		expect((await move(b, { op: "status", moveId: "move-p6" })).data).toEqual({ state: "accepted" });
	});

	it("#given a move that is not accepted #when the caller asks status #then nothing names a path", async () => {
		const fixture = await devices();
		await using b = createInProcessRig(fixture.agentB);
		await move(b, { op: "prepare", moveId: "move-p7" });

		expect((await move(b, { op: "status", moveId: "move-p7" })).data).toEqual({ state: "receiving" });
		expect((await move(b, { op: "status", moveId: "move-p8" })).data).toEqual({
			state: "declined",
			reason: "no_record",
		});
	});
});
