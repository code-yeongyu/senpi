/**
 * `move_session` op `revoke` (senpi#4003): the receiving device seals the copy it imported for a move once the sender
 * took the session back, so two writable copies never exist.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { holdSessionFile } from "../../src/core/session-holders.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionMovedAwayError } from "../../src/core/session-move/ownership.ts";
import { moveLockKey } from "../../src/core/session-move/session-lock.ts";
import { serializeByKey } from "../../src/core/session-sidecar-store.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, hostAndRelease, importedOnB, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const lastEntry = (file: string) =>
	JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1) ?? "{}") as {
		customType?: string;
		data?: Record<string, unknown>;
	};

describe("move_session revoke (senpi#4003)", () => {
	it("#given B imported the move #when revoke runs #then the copy is sealed read-only, and a repeat is a no-op", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-r1");

		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-r1" })).toMatchObject({
			success: true,
			command: "move_session",
			data: { ownership: "moved" },
		});
		expect(customTypes(onB)).toEqual(["session_released", "session_moved_in", "session_moved"]);
		expect(lastEntry(onB).data).toMatchObject({
			move_id: "move-r1",
			session_id: SESSION_ID,
			reason: "revoked",
			target: "device-a",
		});
		expect(() =>
			SessionManager.open(onB).appendMessage({ role: "user", content: "after revoke", timestamp: 9 }),
		).toThrow(SessionMovedAwayError);

		const before = readFileSync(onB, "utf8");
		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-r1" })).toMatchObject({
			success: true,
			data: { ownership: "moved" },
		});
		expect(readFileSync(onB, "utf8")).toBe(before);
	});

	it("#given B imported one move #when revoke names another move #then it refuses move_mismatch and changes nothing", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-r2");
		const before = readFileSync(onB, "utf8");

		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-other" })).toMatchObject({
			success: false,
			error: "move_mismatch",
			errorData: { detail: expect.any(String) },
		});
		expect(readFileSync(onB, "utf8")).toBe(before);
	});

	it("#given a writable session that was never imported #then revoke refuses move_mismatch and seals nothing", async () => {
		const { agentA, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		const before = readFileSync(sessionPath, "utf8");

		expect(await move(a, { op: "revoke", sessionPath, moveId: "move-r3" })).toMatchObject({
			success: false,
			error: "move_mismatch",
		});
		expect(readFileSync(sessionPath, "utf8")).toBe(before);
		expect(() =>
			SessionManager.open(sessionPath).appendMessage({ role: "user", content: "still mine", timestamp: 9 }),
		).not.toThrow();
	});

	it("#given the sender's own released file #then revoke refuses it: only an import is revoked", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-r4");

		expect(await move(a, { op: "revoke", sessionPath: fixture.sessionPath, moveId: "move-r4" })).toMatchObject({
			success: false,
			error: "move_mismatch",
		});
		expect(customTypes(fixture.sessionPath)).toEqual(["session_released"]);
	});

	it("#given another process holds the imported copy #then revoke refuses session_held under the move lock", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-r5");
		const otherGeneration = holdSessionFile(onB, SESSION_ID, { expectExisting: true });

		const refused = await move(b, { op: "revoke", sessionPath: onB, moveId: "move-r5" });
		otherGeneration.release();

		expect(refused).toMatchObject({ success: false, error: "session_held" });
		expect(customTypes(onB)).toEqual(["session_released", "session_moved_in"]);
	});

	it("#given the copy opens here while revoke waits for the move lock #then revoke refuses session_open_here", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-r6");
		let unblock = (): void => {};
		const blocker = serializeByKey(
			await moveLockKey(onB),
			() =>
				new Promise<void>((resolve) => {
					unblock = resolve;
				}),
		);

		const revoking = move(b, { op: "revoke", sessionPath: onB, moveId: "move-r6" });
		opened(await b.open("conn-b", { cwd: fixture.repoB, sessionPath: onB, retain_on_disconnect: true }), 0);
		unblock();
		await blocker;

		expect(await revoking).toMatchObject({ success: false, error: "session_open_here" });
		expect(customTypes(onB)).toEqual(["session_released", "session_moved_in"]);
	});

	it("#given B revoked its import #when status asks about that move with the copy's path #then it answers accepted with revoked: true", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-r7");
		expect((await move(b, { op: "status", moveId: "move-r7", sessionPath: onB })).data).toEqual({
			state: "accepted",
		});

		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-r7" })).toMatchObject({ success: true });

		expect(await move(b, { op: "status", moveId: "move-r7", sessionPath: onB })).toMatchObject({
			success: true,
			data: { state: "accepted", revoked: true },
		});
		// accepted + revoked: the engine's write guard refuses the copy.
		expect(() =>
			SessionManager.open(onB).appendMessage({ role: "user", content: "after revoke", timestamp: 9 }),
		).toThrow(SessionMovedAwayError);
		// Without the copy's path the ledger answers: its record stays `accepted` and carries the revoke too.
		expect((await move(b, { op: "status", moveId: "move-r7" })).data).toEqual({ state: "accepted", revoked: true });
	});

	it("#given the receiver wrote turns on its copy after the import #then revoke still seals it, keeps those turns, and refuses later writes", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-r8");
		SessionManager.open(onB).appendMessage({ role: "user", content: "typed on B", timestamp: 5 });

		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-r8" })).toMatchObject({
			success: true,
			data: { ownership: "moved" },
		});
		expect(readFileSync(onB, "utf8")).toContain("typed on B");
		expect(customTypes(onB)).toEqual(["session_released", "session_moved_in", "session_moved"]);
		expect(() =>
			SessionManager.open(onB).appendMessage({ role: "user", content: "after revoke", timestamp: 9 }),
		).toThrow(SessionMovedAwayError);
	});

	it("#given B's copy was re-imported for a later move #when revoke names the earlier move #then it refuses move_mismatch", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const first = await importedOnB(a, b, fixture, "move-r9a");
		const accepted = { state: "accepted" };
		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-r9a", answer: accepted }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });

		await move(a, { op: "prepare", moveId: "move-r9b" });
		await hostAndRelease(b, fixture.repoB, first, "move-r9b");
		const back = await move(b, { op: "export", sessionPath: first, moveId: "move-r9b", target: "device-a" });
		const backDir = (back.data as { bundle_dir: string }).bundle_dir;
		expect(await move(a, { op: "import", bundleDir: backDir, cwd: fixture.repoA, from: "device-b" })).toMatchObject({
			success: true,
			data: { session_path: fixture.sessionPath },
		});
		expect(await move(b, { op: "finish", sessionPath: first, moveId: "move-r9b", answer: accepted })).toMatchObject({
			success: true,
			data: { ownership: "moved" },
		});

		const again = await importedOnB(a, b, fixture, "move-r9c");
		expect(again).toBe(first);
		const before = readFileSync(again, "utf8");
		expect(await move(b, { op: "revoke", sessionPath: again, moveId: "move-r9a" })).toMatchObject({
			success: false,
			error: "move_mismatch",
		});
		expect(readFileSync(again, "utf8")).toBe(before);
	});
});
