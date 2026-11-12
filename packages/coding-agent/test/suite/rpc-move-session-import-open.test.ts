/**
 * `move_session import` with `sessionDir` and `open` (senpi#6267): the caller names the folder the session lands in, as
 * `copy` already lets it, and the import opens the landed session on the importing connection, so a move to another
 * host needs no separate `open_session`. A failed open never undoes an import that landed.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, exportedForB, move, moveAs } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

async function readyToImport(moveId: string) {
	const fixture = await devices();
	const a = createInProcessRig(fixture.agentA);
	const b = createInProcessRig(fixture.agentB);
	const bundleDir = await exportedForB(a, b, fixture, moveId);
	const importFields = { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" } as const;
	return { fixture, a, b, importFields };
}

describe("move_session import: sessionDir and open (senpi#6267)", () => {
	it("#given a sessionDir #then the session lands there and the move's record answers for that file", async () => {
		const { fixture, a, b, importFields } = await readyToImport("move-d1");
		await using _a = a;
		await using _b = b;
		const sessionDir = join(fixture.base, "landing");

		const imported = await move(b, { ...importFields, sessionDir });

		expect(imported).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
		const landed = (imported.data as { session_path: string }).session_path;
		expect(dirname(landed)).toBe(sessionDir);
		expect(existsSync(join(getDefaultSessionDir(fixture.repoB, fixture.agentB), basename(landed)))).toBe(false);
		expect(await move(b, { op: "status", moveId: "move-d1", sessionPath: landed })).toMatchObject({
			success: true,
			data: { state: "accepted" },
		});
	});

	it.each<[string, (base: string) => string]>([
		["is not absolute", () => "landing"],
		[
			"names an existing file",
			(base) => {
				writeFileSync(join(base, "a-file"), "x\n");
				return join(base, "a-file");
			},
		],
		[
			"lies under an existing file",
			(base) => {
				writeFileSync(join(base, "a-file"), "x\n");
				return join(base, "a-file", "landing");
			},
		],
		[
			"cannot be looked at (a symlink loop)",
			(base) => {
				symlinkSync(join(base, "loop-b"), join(base, "loop-a"));
				symlinkSync(join(base, "loop-a"), join(base, "loop-b"));
				return join(base, "loop-a", "landing");
			},
		],
	])("#given a sessionDir that %s #then import refuses it and the move stays importable", async (_case, dirIn) => {
		const { fixture, a, b, importFields } = await readyToImport("move-d2");
		await using _a = a;
		await using _b = b;

		expect(await move(b, { ...importFields, sessionDir: dirIn(fixture.base) })).toMatchObject({
			success: false,
			errorCode: "invalid_move_request",
		});
		expect(existsSync(join(fixture.repoB, "landing"))).toBe(false);
		expect((await move(b, { op: "status", moveId: "move-d2" })).data).toEqual({ state: "receiving" });
		expect(await move(b, importFields)).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
	});

	it("#given open asked #when the import lands #then the same answer carries the opened session and B hosts it for the caller", async () => {
		const { a, b, importFields } = await readyToImport("move-o1");
		await using _a = a;
		await using _b = b;

		const reply = await moveAs(b, "conn-b", { ...importFields, open: true });

		expect(reply).toMatchObject({
			id: "mv",
			type: "response",
			command: "move_session",
			success: true,
			data: { session_id: SESSION_ID, sessionId: expect.any(String), state: { sessionId: SESSION_ID } },
		});
		const data = reply.data as { session_path: string; sessionId: string; state: { sessionFile: string } };
		expect(data.state.sessionFile).toBe(data.session_path);
		expect(await b.list()).toMatchObject([
			{ sessionId: data.sessionId, sessionPath: data.session_path, attachments: 1 },
		]);
	});

	it.each([
		["a plain open", "the session goes with it", true, 0],
		["an open retained on disconnect", "the session stays loaded", { retain_on_disconnect: true }, 1],
	])("#given %s #when the importing connection drops #then %s", async (_case, _outcome, open, stillLoaded) => {
		const { a, b, importFields } = await readyToImport("move-o2");
		await using _a = a;
		await using _b = b;
		expect(await moveAs(b, "conn-b", { ...importFields, open })).toMatchObject({ success: true });
		expect(await b.list()).toHaveLength(1);

		await b.drop("conn-b");

		expect(await b.list()).toHaveLength(stillLoaded);
	});

	it("#given an open the host refuses #then the import still answers success with open_error and the move is accepted", async () => {
		const { a, b, importFields } = await readyToImport("move-o3");
		await using _a = a;
		await using _b = b;

		const reply = await moveAs(b, "conn-b", { ...importFields, open: { kind: "not-a-kind" } });

		expect(reply).toMatchObject({
			success: true,
			data: { session_id: SESSION_ID, open_error: { error: expect.stringContaining("invalid_session_kind") } },
		});
		expect(reply.data).not.toHaveProperty("state");
		expect(await b.list()).toEqual([]);
		expect(await move(b, { op: "status", moveId: "move-o3" })).toMatchObject({ data: { state: "accepted" } });
	});

	it.each<[string, unknown]>([
		["is neither true nor open_session fields", "yes"],
		["names the folder, which is the import's own", { cwd: "/elsewhere" }],
		["names an admission, which is the import's own", { admissionId: "admission-1" }],
	])("#given an open that %s #then import refuses it before importing", async (_case, open) => {
		const { fixture, a, b, importFields } = await readyToImport("move-o4");
		await using _a = a;
		await using _b = b;

		expect(await moveAs(b, "conn-b", { ...importFields, open })).toMatchObject({
			success: false,
			errorCode: "invalid_move_request",
		});
		const landing = join(getDefaultSessionDir(fixture.repoB, fixture.agentB), basename(fixture.sessionPath));
		expect(existsSync(landing)).toBe(false);
		expect(await b.list()).toEqual([]);
	});

	it("#given a session landed in a sessionDir for one folder #when the same bundle is imported there again for another folder, with open #then it is refused move_fenced and nothing is opened, and the first folder is still answered the landed session", async () => {
		const { fixture, a, b, importFields } = await readyToImport("move-d3");
		await using _a = a;
		await using _b = b;
		const sessionDir = join(fixture.base, "landing");
		const elsewhere = join(fixture.base, "not-a-repository");
		mkdirSync(elsewhere);
		const first = await move(b, { ...importFields, sessionDir });
		const landed = (first.data as { session_path: string }).session_path;
		const before = readFileSync(landed, "utf8");

		const again = await moveAs(b, "conn-b", { ...importFields, sessionDir, cwd: elsewhere, open: true });

		expect(again).toMatchObject({ success: false, errorCode: "move_fenced" });
		expect(await b.list()).toEqual([]);
		expect(readFileSync(landed, "utf8")).toBe(before);
		expect(await move(b, { ...importFields, sessionDir })).toMatchObject({
			success: true,
			data: { session_id: SESSION_ID, session_path: landed },
		});
	});

	it("#given a host that began draining #when an import asks to open what it lands #then the import lands, answers open_error host_draining, and nothing is hosted", async () => {
		const { a, b, importFields } = await readyToImport("move-o5");
		await using _a = a;
		await using _b = b;
		b.router.beginDrain();

		const reply = await moveAs(b, "conn-b", { ...importFields, open: true });

		expect(reply).toMatchObject({
			success: true,
			data: { session_id: SESSION_ID, open_error: { error: expect.stringContaining("host_draining") } },
		});
		expect(reply.data).not.toHaveProperty("state");
		expect(await b.list()).toEqual([]);
		expect(await move(b, { op: "status", moveId: "move-o5" })).toMatchObject({ data: { state: "accepted" } });
	});
});
