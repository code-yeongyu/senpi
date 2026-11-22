/**
 * `move_session` (senpi#3676): the RPC commands a transport and the clients use to drive a session move between two
 * hosts. Two in-process rigs stand in for two devices (each with its own agent directory, so its own move ledger and
 * session folders), and two git checkouts of one repository stand in for the user's working copies.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionMovedAwayError } from "../../src/core/session-move/ownership.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, hostAndRelease, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

describe("move_session over RPC (senpi#3676)", () => {
	it("#given two hosts #then ready, release, export, import, status and finish move the session to B under the same id", async () => {
		const { repoA, repoB, agentA, agentB, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);

		expect(await move(b, { op: "prepare", moveId: "move-1" })).toMatchObject({
			success: true,
			command: "move_session",
			data: { state: "ready", expires_at: expect.any(String) },
		});
		const { released } = await hostAndRelease(a, repoA, sessionPath, "move-1");
		expect(released).toMatchObject({ success: true });

		const exported = await move(a, {
			op: "export",
			sessionPath,
			moveId: "move-1",
			target: "device-b",
			droppedUserMessages: ["queued follow-up"],
		});
		expect(exported).toMatchObject({ success: true, data: { move_id: "move-1", session_id: SESSION_ID } });
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;
		expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
		expect(bundleDir.startsWith(agentA)).toBe(true);

		const imported = await move(b, { op: "import", bundleDir, cwd: repoB, from: "device-a" });
		expect(imported).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
		const onB = (imported.data as { session_path: string }).session_path;
		expect(onB.startsWith(agentB)).toBe(true);
		expect(readFileSync(onB, "utf8")).toContain("remember 42");
		expect(() =>
			SessionManager.open(onB).appendMessage({ role: "user", content: "on B", timestamp: 2 }),
		).not.toThrow();

		const status = await move(b, { op: "status", moveId: "move-1" });
		expect(status).toMatchObject({ success: true, data: { state: "accepted" } });

		expect(
			await move(a, { op: "finish", sessionPath, moveId: "move-1", answer: { state: "accepted" } }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
		expect(customTypes(sessionPath)).toEqual(["session_released", "session_moved"]);
		expect(existsSync(bundleDir)).toBe(false);
		expect(() =>
			SessionManager.open(sessionPath).appendMessage({ role: "user", content: "late", timestamp: 3 }),
		).toThrow(SessionMovedAwayError);
	});

	it("#given a session that was not released for this move #then export refuses it and seals nothing", async () => {
		const { repoA, agentA, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		const session = opened(await a.open("conn-a", { cwd: repoA, sessionPath, retain_on_disconnect: true }), 0);

		const hosted = await move(a, { op: "export", sessionPath, moveId: "move-2", target: "device-b" });
		expect(hosted).toMatchObject({ success: false, error: "session_open_here" });
		await a.router.handle({ type: "close_session", id: "c", sessionId: session.sessionId });
		await a.settle();

		const unreleased = await move(a, { op: "export", sessionPath, moveId: "move-2", target: "device-b" });
		expect(unreleased).toMatchObject({ success: false, error: "move_not_released" });
		expect(customTypes(sessionPath)).toEqual([]);
	});

	it("#given a bundle for a move B never readied #then the import is refused and B is fenced for that move", async () => {
		const { repoA, repoB, agentA, agentB, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);
		await hostAndRelease(a, repoA, sessionPath, "move-3");
		const exported = await move(a, { op: "export", sessionPath, moveId: "move-3", target: "device-b" });
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;

		expect(await move(b, { op: "import", bundleDir, cwd: repoB })).toMatchObject({
			success: false,
			error: "move_fenced",
			errorData: { detail: expect.any(String) },
		});
		expect(await move(b, { op: "status", moveId: "move-3" })).toMatchObject({
			success: true,
			data: { state: "declined", reason: "chunk_without_ready" },
		});
	});

	it("#given B cancelled #when A finishes with the decline #then A takes the session back with its queued input", async () => {
		const { repoA, agentA, agentB, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);
		await move(b, { op: "prepare", moveId: "move-4" });
		await hostAndRelease(a, repoA, sessionPath, "move-4");
		await move(a, {
			op: "export",
			sessionPath,
			moveId: "move-4",
			target: "device-b",
			droppedUserMessages: ["keep me"],
		});

		const cancelled = await move(b, { op: "cancel", moveId: "move-4" });
		expect(cancelled).toMatchObject({ success: true, data: { state: "declined", reason: "cancelled" } });
		const answer = (await move(b, { op: "status", moveId: "move-4" })).data;

		expect(await move(a, { op: "finish", sessionPath, moveId: "move-4", answer })).toMatchObject({
			success: true,
			data: { ownership: "writable" },
		});
		expect(customTypes(sessionPath)).toEqual(["session_released", "session_reclaimed"]);
		expect(readFileSync(sessionPath, "utf8")).toContain("keep me");
	});

	it("#given a move id that is not a plain id or an unknown op #then the command is refused before touching anything", async () => {
		const { agentB } = await devices();
		await using b = createInProcessRig(agentB);
		for (const moveId of ["../x", "", "a/b"]) {
			expect(await move(b, { op: "prepare", moveId })).toMatchObject({
				success: false,
				error: "invalid_move_request",
			});
		}
		expect(await move(b, { op: "teleport", moveId: "m" })).toMatchObject({
			success: false,
			error: "invalid_move_request",
		});
		expect(existsSync(join(agentB, "session-moves", "ledger", "..json"))).toBe(false);
	});
});
