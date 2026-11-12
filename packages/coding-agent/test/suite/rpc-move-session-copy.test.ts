/**
 * `move_session` op `copy` (senpi#5889): work goes on from a session that is read-only here (a revoked import, a
 * session that moved away) in a new session under a caller-chosen id. The copy is writable; the source is only read.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { SessionMovedAwayError } from "../../src/core/session-move/ownership.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, importedOnB, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const COPY_ID = "copy-5889";

async function revokedOnB(moveId: string) {
	const fixture = await devices();
	const a = createInProcessRig(fixture.agentA);
	const b = createInProcessRig(fixture.agentB);
	const onB = await importedOnB(a, b, fixture, moveId);
	await move(b, { op: "revoke", sessionPath: onB, moveId });
	return { fixture, a, b, onB };
}

describe("move_session copy (senpi#5889)", () => {
	it("#given a revoked copy #when copy runs under a new id #then the new session is writable and the source is untouched", async () => {
		const { fixture, a, b, onB } = await revokedOnB("move-c1");
		await using _a = a;
		await using _b = b;
		const before = readFileSync(onB, "utf8");

		const reply = await move(b, { op: "copy", sessionPath: onB, sessionId: COPY_ID });

		expect(reply).toMatchObject({ success: true, command: "move_session", data: { session_id: COPY_ID } });
		const copyPath = (reply.data as { session_path: string }).session_path;
		expect(dirname(copyPath)).toBe(getDefaultSessionDir(fixture.repoB, fixture.agentB));
		const copy = SessionManager.open(copyPath);
		expect(copy.getSessionId()).toBe(COPY_ID);
		expect(readFileSync(copyPath, "utf8")).toContain("remember 42");
		copy.appendMessage({ role: "user", content: "typed in the copy", timestamp: 9 });
		expect(readFileSync(copyPath, "utf8")).toContain("typed in the copy");
		expect(readFileSync(onB, "utf8")).toBe(before);
		expect(() =>
			SessionManager.open(onB).appendMessage({ role: "user", content: "after copy", timestamp: 10 }),
		).toThrow(SessionMovedAwayError);
	});

	it("#given a sessionDir #then the copy lands there", async () => {
		const { a, b, onB } = await revokedOnB("move-c2");
		await using _a = a;
		await using _b = b;
		const sessionDir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-copy-dir-")));

		const reply = await move(b, { op: "copy", sessionPath: onB, sessionId: COPY_ID, sessionDir });

		expect(reply).toMatchObject({ success: true });
		expect(dirname((reply.data as { session_path: string }).session_path)).toBe(sessionDir);
	});

	it.each([
		["an id a session in that folder already has", "move_target_occupied", "taken"],
		["the source's own id", "invalid_move_request", SESSION_ID],
		["an id that is not plain", "invalid_move_request", "../escape"],
		["an id ending in a separator", "invalid_move_request", "copy-"],
		["an id ending in a dot", "invalid_move_request", "a."],
	])("#given %s #then copy refuses with %s and writes nothing", async (_case, code, sessionId) => {
		const { fixture, a, b, onB } = await revokedOnB(`move-c3-${code}-${sessionId.length}`);
		await using _a = a;
		await using _b = b;
		const dir = getDefaultSessionDir(fixture.repoB, fixture.agentB);
		if (sessionId === "taken")
			expect(await move(b, { op: "copy", sessionPath: onB, sessionId })).toMatchObject({ success: true });
		const files = readdirSync(dir);

		const reply = await move(b, { op: "copy", sessionPath: onB, sessionId });

		expect(reply).toMatchObject({ success: false, errorCode: code });
		expect(readdirSync(dir)).toEqual(files);
		expect(existsSync(onB)).toBe(true);
	});

	it("#given a copy whose inherited ownership entries name an older id #when copy runs under that older id #then copy refuses with invalid_move_request and writes nothing (senpi#5930)", async () => {
		const { a, b, onB } = await revokedOnB("move-c4-copy-back");
		await using _a = a;
		await using _b = b;
		const sessionDir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-copy-back-")));
		const first = await move(b, { op: "copy", sessionPath: onB, sessionId: COPY_ID, sessionDir });
		expect(first).toMatchObject({ success: true });
		const files = readdirSync(sessionDir);

		const reply = await move(b, {
			op: "copy",
			sessionPath: (first.data as { session_path: string }).session_path,
			sessionId: SESSION_ID,
			sessionDir,
		});

		expect(reply).toMatchObject({ success: false, errorCode: "invalid_move_request" });
		expect(readdirSync(sessionDir)).toEqual(files);
	});
});
