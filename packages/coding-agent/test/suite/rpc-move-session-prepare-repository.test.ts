/**
 * A repository check before the release (senpi#6435). The source answers a session's recorded repository identity
 * without releasing it (`identity`). The target's `prepare` takes the folder and that identity, refuses a folder that
 * is not a checkout of the same repository before anything is readied, and holds the import to the folder it checked.
 * Two in-process hosts stand in for two devices, and git checkouts for the user's working copies.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir, loadEntriesFromFile } from "../../src/core/session-manager.ts";
import { sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { cloneOf, devices, hostAndRelease, move, type Rig, unrelatedRepo } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

type Fixture = Awaited<ReturnType<typeof devices>>;

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);
const landing = (cwd: string, fixture: Fixture) =>
	join(getDefaultSessionDir(cwd, fixture.agentB), basename(fixture.sessionPath));

/** What the source answers for a session file: the identity a caller passes on to the target's `prepare`. */
async function recordedIdentity(a: Rig, sessionPath: string): Promise<unknown> {
	const answer = await move(a, { op: "identity", sessionPath });
	expect(answer).toMatchObject({ success: true, command: "move_session" });
	return (answer.data as { repository?: unknown }).repository;
}

/** A releases and exports the fixture's session for `moveId`; returns the bundle folder. */
async function exported(a: Rig, fixture: Fixture, moveId: string): Promise<string> {
	await hostAndRelease(a, fixture.repoA, fixture.sessionPath, moveId);
	const answer = await move(a, { op: "export", sessionPath: fixture.sessionPath, moveId, target: "device-b" });
	return (answer.data as { bundle_dir: string }).bundle_dir;
}

// senpi#6435
describe("move_session checks the repository before the release (senpi#6435)", () => {
	it("#given a session recorded in one repository and a target folder that is a checkout of another #when the caller reads the source's identity and sends it to the target's prepare with that folder #then prepare is refused move_repository_mismatch, no move is readied, and the source's session is still hosted and writable", async () => {
		const fixture = await devices();
		const other = unrelatedRepo(join(fixture.base, "other"));
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const session = opened(
			await a.open("conn-a", { cwd: fixture.repoA, sessionPath: fixture.sessionPath, retain_on_disconnect: true }),
			0,
		);
		const before = readFileSync(fixture.sessionPath, "utf8");

		const identity = await move(a, { op: "identity", sessionPath: fixture.sessionPath });
		expect(identity).toEqual({
			id: "mv",
			type: "response",
			command: "move_session",
			success: true,
			data: { repository: { rootCommits: [fixture.root] } },
		});
		const refused = await move(b, {
			op: "prepare",
			moveId: "move-p1",
			cwd: other,
			repository: (identity.data as { repository: unknown }).repository,
		});

		expect(refused).toMatchObject({
			success: false,
			command: "move_session",
			errorCode: "move_repository_mismatch",
			errorData: { detail: expect.any(String) },
		});
		expect(existsSync(ledgerFile(fixture.agentB, "move-p1"))).toBe(false);
		// The source: nothing was released, sealed or recorded, and the hosted session still takes a turn's write.
		expect((await a.list()).map((row) => row.sessionId)).toEqual([session.sessionId]);
		expect(readFileSync(fixture.sessionPath, "utf8")).toBe(before);
		expect(existsSync(join(fixture.agentA, "session-moves"))).toBe(false);
		const turn = a.turns.get(session.state.sessionFile);
		if (turn === undefined) throw new Error("the rig hosts no turn for the session");
		turn.start();
		turn.finish();
		expect(readFileSync(fixture.sessionPath, "utf8")).toContain("turn result");
		expect(sessionOwnership(loadEntriesFromFile(fixture.sessionPath)).writable).toBe(true);
	});

	it("#given the same session and a checkout of the same repository #then prepare readies the move, and an import of that move into another folder is refused", async () => {
		const fixture = await devices();
		const third = cloneOf(fixture.repoA, join(fixture.base, "c", "repo"));
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const repository = await recordedIdentity(a, fixture.sessionPath);

		const readied = await move(b, { op: "prepare", moveId: "move-p2", cwd: fixture.repoB, repository });

		// The answer is the ready record as before: the folder it keeps is never part of it.
		expect(readied).toMatchObject({ success: true });
		expect(readied.data).toEqual({ state: "ready", expires_at: expect.any(String) });
		const bundleDir = await exported(a, fixture, "move-p2");
		// What the source answered before the release is what its bundle carries.
		expect(JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")).repository).toEqual(repository);

		expect(await move(b, { op: "import", bundleDir, cwd: third, from: "device-a" })).toMatchObject({
			success: false,
			errorCode: "move_fenced",
		});
		expect(existsSync(landing(third, fixture))).toBe(false);
		const imported = await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" });
		expect(imported).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
		expect(dirname((imported.data as { session_path: string }).session_path)).toBe(
			getDefaultSessionDir(fixture.repoB, fixture.agentB),
		);
	});

	it("#given a move readied for one folder #when its bundle is imported into a checkout of another repository #then it is refused move_fenced, and the move still lands in the readied folder", async () => {
		const fixture = await devices();
		const other = unrelatedRepo(join(fixture.base, "other"));
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await move(b, {
			op: "prepare",
			moveId: "move-p2b",
			cwd: fixture.repoB,
			repository: { rootCommits: [fixture.root] },
		});
		const bundleDir = await exported(a, fixture, "move-p2b");

		// The folder decides first: an import the move was not readied for never settles the move.
		expect(await move(b, { op: "import", bundleDir, cwd: other, from: "device-a" })).toMatchObject({
			success: false,
			errorCode: "move_fenced",
		});

		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" })).toMatchObject({
			success: true,
			data: { session_id: SESSION_ID },
		});
		expect((await move(b, { op: "status", moveId: "move-p2b" })).data).toEqual({ state: "accepted" });
	});

	it("#given a prepare with no folder and no repository #then it readies the move as before", async () => {
		const fixture = await devices();
		const third = cloneOf(fixture.repoA, join(fixture.base, "c", "repo"));
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);

		expect(await move(b, { op: "prepare", moveId: "move-p3" })).toEqual({
			id: "mv",
			type: "response",
			command: "move_session",
			success: true,
			data: { state: "ready", expires_at: expect.any(String) },
		});

		// An older caller's move is held to no folder: its import lands in the folder the import names.
		const bundleDir = await exported(a, fixture, "move-p3");
		const imported = await move(b, { op: "import", bundleDir, cwd: third, from: "device-a" });
		expect(imported).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
		expect((imported.data as { session_path: string }).session_path).toBe(landing(third, fixture));
	});

	it("#given a session that recorded no repository #when its identity is read and prepare gets the folder alone #then identity answers no repository and prepare is refused move_repository_mismatch", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const bareId = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d4";
		const bare = join(dirname(fixture.sessionPath), `2026-10-19T00-00-02-000Z_${bareId}.jsonl`);
		const lines = [
			{ type: "session", version: 3, id: bareId, timestamp: "2026-10-19T00:00:02.000Z", cwd: fixture.repoA },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-10-19T00:00:03.000Z",
				message: { role: "user", content: "no repository here", timestamp: 1 },
			},
		];
		writeFileSync(bare, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const identity = await move(a, { op: "identity", sessionPath: bare });
		const refused = await move(b, { op: "prepare", moveId: "move-p4", cwd: fixture.repoB });

		expect(identity).toMatchObject({ success: true });
		expect(identity.data).toEqual({});
		expect(refused).toMatchObject({ success: false, errorCode: "move_repository_mismatch" });
		expect(existsSync(ledgerFile(fixture.agentB, "move-p4"))).toBe(false);
	});

	it("#given a move readied for one folder #when prepare is repeated #then the same folder answers the same record and another folder is refused move_fenced", async () => {
		const fixture = await devices();
		const third = cloneOf(fixture.repoA, join(fixture.base, "c", "repo"));
		await using b = createInProcessRig(fixture.agentB);
		const repository = { rootCommits: [fixture.root] };
		const first = await move(b, { op: "prepare", moveId: "move-p5", cwd: fixture.repoB, repository });
		expect(first).toMatchObject({ success: true, data: { state: "ready" } });

		expect(await move(b, { op: "prepare", moveId: "move-p5", cwd: fixture.repoB, repository })).toEqual(first);
		expect(await move(b, { op: "prepare", moveId: "move-p5", cwd: third, repository })).toMatchObject({
			success: false,
			errorCode: "move_fenced",
		});
		// A prepare that names no folder, as an older caller sends it, answers the same record and keeps the folder.
		expect(await move(b, { op: "prepare", moveId: "move-p5" })).toEqual(first);
		expect(await move(b, { op: "prepare", moveId: "move-p5", cwd: third, repository })).toMatchObject({
			success: false,
			errorCode: "move_fenced",
		});
		// A move that was readied and never imported is still cancelled as before.
		expect((await move(b, { op: "cancel", moveId: "move-p5" })).data).toEqual({
			state: "declined",
			reason: "cancelled",
		});
	});

	// One folder has one spelling: it is kept and compared as the import resolves its `cwd`.
	it.each([
		["a trailing slash", (repo: string) => `${repo}/`, (repo: string) => repo],
		["a trailing slash, imported with it too", (repo: string) => `${repo}/`, (repo: string) => `${repo}/`],
		["a . segment", (repo: string) => `${dirname(repo)}/./${basename(repo)}`, (repo: string) => repo],
		["a .. segment", (repo: string) => `${dirname(repo)}/a/../${basename(repo)}`, (repo: string) => repo],
		["a doubled slash", (repo: string) => `${dirname(repo)}//${basename(repo)}`, (repo: string) => repo],
	])(
		"#given a move readied for a checkout spelled with %s #when its bundle is imported into that checkout #then it lands",
		async (_spelling, readiedFor, importedInto) => {
			const fixture = await devices();
			await using a = createInProcessRig(fixture.agentA);
			await using b = createInProcessRig(fixture.agentB);
			const repository = await recordedIdentity(a, fixture.sessionPath);
			const cwd = readiedFor(fixture.repoB);
			expect(await move(b, { op: "prepare", moveId: "move-p7", cwd, repository })).toMatchObject({ success: true });
			const bundleDir = await exported(a, fixture, "move-p7");

			const landed = await move(b, { op: "import", bundleDir, cwd: importedInto(fixture.repoB), from: "device-a" });

			expect(landed).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
		},
	);

	it.each([
		["a relative folder", (f: Fixture) => ({ cwd: "work/repo", repository: { rootCommits: [f.root] } })],
		["a repository that is not an object", (f: Fixture) => ({ cwd: f.repoB, repository: "same" })],
		["a repository that is a list", (f: Fixture) => ({ cwd: f.repoB, repository: [] })],
		["a repository that is a list of lists", (f: Fixture) => ({ cwd: f.repoB, repository: [["x"]] })],
		["root commits that are not a list", (f: Fixture) => ({ cwd: f.repoB, repository: { rootCommits: f.root } })],
		["a root commit that is not a string", (f: Fixture) => ({ cwd: f.repoB, repository: { rootCommits: [1] } })],
		[
			"an origin that is not a string",
			(f: Fixture) => ({ cwd: f.repoB, repository: { rootCommits: [f.root], originUrl: 5 } }),
		],
		["a repository without a folder", (f: Fixture) => ({ repository: { rootCommits: [f.root] } })],
	])(
		"#given a prepare whose folder is relative, whose repository is malformed, or that names a repository without a folder (%s) #then it is refused invalid_move_request and no move is readied",
		async (_case, fields) => {
			const fixture = await devices();
			await using b = createInProcessRig(fixture.agentB);

			const refused = await move(b, { op: "prepare", moveId: "move-p6", ...fields(fixture) });

			expect(refused).toMatchObject({ success: false, errorCode: "invalid_move_request" });
			expect(existsSync(ledgerFile(fixture.agentB, "move-p6"))).toBe(false);
		},
	);
});
