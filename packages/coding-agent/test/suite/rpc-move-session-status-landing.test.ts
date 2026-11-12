/**
 * `move_session` op `status` can name the place a move would have landed (`landing`), so the answer comes from the
 * session file there before it comes from the ledger. A move's record can be lost while its session landed; a sender
 * that reads "no record" as "never arrived" then takes the session back and two copies are writable. With `landing`,
 * a landed move answers `accepted` from its file, and `declined: no_record` only when no landing is there.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import {
	devices,
	hostAndRelease,
	importedOnB,
	landedOnB,
	move,
	revokedLandingOnB,
} from "./rpc-move-session-support.ts";

type Fixture = Awaited<ReturnType<typeof devices>>;

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);
const recorded = (agentDir: string, moveId: string) =>
	JSON.parse(readFileSync(ledgerFile(agentDir, moveId), "utf8")) as { state: string; reason?: string };

/** Where the fixture's session lands on B: the folder the import was given and the file name its bundle carried. */
const landingOnB = (fixture: Fixture) => ({ cwd: fixture.repoB, sessionFileName: basename(fixture.sessionPath) });

describe("move_session status answers from the file at the landing it is given", () => {
	it("#given a move that landed here and whose ledger record was lost #when status names the landing #then it answers accepted with where the session landed, and creates no record", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-l1");
		rmSync(ledgerFile(fixture.agentB, "move-l1"));

		const answer = await move(b, { op: "status", moveId: "move-l1", landing: landingOnB(fixture) });

		expect(answer.data).toEqual({ state: "accepted", ...landedOnB(fixture, onB) });
		expect(existsSync(ledgerFile(fixture.agentB, "move-l1"))).toBe(false);
	});

	it("#given a landed move that was revoked and whose record was lost #when status names the landing #then it answers accepted and revoked", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-l2");
		await move(b, { op: "revoke", sessionPath: onB, moveId: "move-l2" });
		rmSync(ledgerFile(fixture.agentB, "move-l2"));

		const answer = await move(b, { op: "status", moveId: "move-l2", landing: landingOnB(fixture) });

		expect(answer.data).toEqual({ state: "accepted", revoked: true, ...revokedLandingOnB(fixture, onB, "move-l2") });
	});

	it("#given the landed file sits in the folder the import named and the record was lost #when status names that folder as sessionDir #then it answers accepted with the file there", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-l3");
		const named = join(fixture.base, "named-sessions");
		mkdirSync(named);
		const inNamed = join(named, basename(onB));
		renameSync(onB, inNamed);
		rmSync(ledgerFile(fixture.agentB, "move-l3"));

		const answer = await move(b, {
			op: "status",
			moveId: "move-l3",
			landing: { ...landingOnB(fixture), sessionDir: named },
		});

		expect(answer.data).toEqual({ state: "accepted", ...landedOnB(fixture, inNamed) });
	});

	it("#given the copy an earlier move of the same session left at the landing path, and no record of this move #when status names the landing #then that file is not this move's landing: it answers declined no_record and records it", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await importedOnB(a, b, fixture, "move-earlier");

		const answer = await move(b, { op: "status", moveId: "move-back", landing: landingOnB(fixture) });

		expect(answer).toMatchObject({ success: true, data: { state: "declined", reason: "no_record" } });
		expect(recorded(fixture.agentB, "move-back")).toMatchObject({ state: "declined", reason: "no_record" });
	});

	it("#given that earlier copy at the landing path, and a record that declined this move #when status names the landing #then it answers the record", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await importedOnB(a, b, fixture, "move-earlier");
		await move(b, { op: "prepare", moveId: "move-back" });
		await move(b, { op: "cancel", moveId: "move-back" });

		const answer = await move(b, { op: "status", moveId: "move-back", landing: landingOnB(fixture) });

		expect(answer.data).toEqual({ state: "declined", reason: "cancelled" });
	});

	it("#given no file at the landing path and no record #when status names the landing #then it answers declined no_record, and that fence stands against a later import of the move", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-late");
		const exported = await move(a, {
			op: "export",
			sessionPath: fixture.sessionPath,
			moveId: "move-late",
			target: "device-b",
		});
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;

		const answer = await move(b, { op: "status", moveId: "move-late", landing: landingOnB(fixture) });

		expect(answer.data).toEqual({ state: "declined", reason: "no_record" });
		const late = await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" });
		expect(late).toMatchObject({ success: false, errorCode: "move_fenced" });
		expect(recorded(fixture.agentB, "move-late")).toMatchObject({ state: "declined", reason: "no_record" });
	});

	it("#given a folder this host holds no sessions for #when status names a landing in it #then it answers from the ledger and makes no session folder", async () => {
		const fixture = await devices();
		await using b = createInProcessRig(fixture.agentB);
		const sessions = join(fixture.agentB, "sessions");
		expect(existsSync(sessions)).toBe(false);

		const answer = await move(b, { op: "status", moveId: "move-nowhere", landing: landingOnB(fixture) });

		expect(answer.data).toEqual({ state: "declined", reason: "no_record" });
		expect(existsSync(sessions)).toBe(false);
	});

	it.each<[string, (fixture: Fixture) => Record<string, unknown>]>([
		["a landing together with sessionPath", (f) => ({ landing: landingOnB(f), sessionPath: f.sessionPath })],
		["a landing that is not an object", () => ({ landing: "here" })],
		["a landing with no cwd", (f) => ({ landing: { sessionFileName: basename(f.sessionPath) } })],
		["a landing whose cwd is relative", (f) => ({ landing: { ...landingOnB(f), cwd: "repo" } })],
		["a landing with no sessionFileName", (f) => ({ landing: { cwd: f.repoB } })],
		[
			"a sessionFileName with a path separator",
			(f) => ({ landing: { ...landingOnB(f), sessionFileName: "a/b.jsonl" } }),
		],
		["a sessionFileName that climbs out", (f) => ({ landing: { ...landingOnB(f), sessionFileName: "..jsonl" } })],
		[
			"a sessionFileName that is no session file",
			(f) => ({ landing: { ...landingOnB(f), sessionFileName: "notes.txt" } }),
		],
		["a relative sessionDir", (f) => ({ landing: { ...landingOnB(f), sessionDir: "sessions" } })],
	])(
		"#given status with %s #then it is refused invalid_move_request and nothing is recorded",
		async (_name, fields) => {
			const fixture = await devices();
			await using b = createInProcessRig(fixture.agentB);

			const answer = await move(b, { op: "status", moveId: "move-bad", ...fields(fixture) });

			expect(answer).toMatchObject({ success: false, errorCode: "invalid_move_request" });
			expect(existsSync(ledgerFile(fixture.agentB, "move-bad"))).toBe(false);
		},
	);
});
