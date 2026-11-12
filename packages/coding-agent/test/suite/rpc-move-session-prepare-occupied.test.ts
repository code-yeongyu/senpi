/**
 * An occupied landing file, refused before the release (senpi#6471). The import refuses a move whose landing file
 * already holds another session, or a writable copy of the moved one, but only after the source released, sealed and
 * exported. `prepare` can make the same check first when the caller names the session: its id and its file's name.
 * It only reads: the import keeps its own check and is the one that replaces a sealed predecessor.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDirPath, loadEntriesFromFile } from "../../src/core/session-manager.ts";
import { sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move, type Rig, unrelatedRepo } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

type Fixture = Awaited<ReturnType<typeof devices>>;

const OTHER_ID = "0197f6e4-4cf9-7f44-a2d8-000000000001";
const READY = { success: true, command: "move_session", data: { state: "ready" } };
const refusedWith = (errorCode: string) => ({ success: false, command: "move_session", errorCode });

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);
const fileName = (fixture: Fixture) => basename(fixture.sessionPath);
/** The session folder a working directory lands in, named only: asking for it must never be what creates it. */
const sessionFolder = (cwd: string, fixture: Fixture) => getDefaultSessionDirPath(cwd, fixture.agentB);
const landingIn = (cwd: string, fixture: Fixture) => join(sessionFolder(cwd, fixture), fileName(fixture));
const named = (fixture: Fixture) => ({ id: SESSION_ID, fileName: fileName(fixture) });
const identity = (fixture: Fixture) => ({ rootCommits: [fixture.root] });

/** The moved session's file as another session would hold that place: the same lines under another id. */
const anotherSession = (fixture: Fixture) => readFileSync(fixture.sessionPath, "utf8").replaceAll(SESSION_ID, OTHER_ID);
/** The moved session's own file while it can still be written. */
const writableCopy = (fixture: Fixture) => readFileSync(fixture.sessionPath, "utf8");

function place(at: string, text: string): string {
	mkdirSync(dirname(at), { recursive: true });
	writeFileSync(at, text);
	return text;
}

const prepare = (b: Rig, fixture: Fixture, moveId: string, extra: Record<string, unknown> = {}) =>
	move(b, {
		op: "prepare",
		moveId,
		cwd: fixture.repoB,
		repository: identity(fixture),
		session: named(fixture),
		...extra,
	});

// senpi#6471
describe("move_session prepare refuses an occupied landing file before the release (senpi#6471)", () => {
	it.each([
		["another session", anotherSession],
		["a writable copy of the same session", writableCopy],
	])(
		"#given a landing file that holds %s #when prepare names the session #then it is refused move_target_occupied and nothing is readied or changed",
		async (_case, content) => {
			const fixture = await devices();
			await using b = createInProcessRig(fixture.agentB);
			const before = place(landingIn(fixture.repoB, fixture), content(fixture));

			const refused = await prepare(b, fixture, "move-o1");

			expect(refused).toMatchObject(refusedWith("move_target_occupied"));
			expect(existsSync(ledgerFile(fixture.agentB, "move-o1"))).toBe(false);
			expect(readFileSync(landingIn(fixture.repoB, fixture), "utf8")).toBe(before);
		},
	);

	it("#given a landing file that holds another session's sealed file #when prepare names the session #then it is refused move_target_occupied, because a sealed file of another session is no predecessor of this one", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-earlier");
		const before = place(
			landingIn(fixture.repoB, fixture),
			readFileSync(fixture.sessionPath, "utf8").replaceAll(SESSION_ID, OTHER_ID),
		);
		expect(sessionOwnership(loadEntriesFromFile(landingIn(fixture.repoB, fixture))).writable).toBe(false);

		const refused = await prepare(b, fixture, "move-o2");

		expect(refused).toMatchObject(refusedWith("move_target_occupied"));
		expect(existsSync(ledgerFile(fixture.agentB, "move-o2"))).toBe(false);
		expect(readFileSync(landingIn(fixture.repoB, fixture), "utf8")).toBe(before);
	});

	it("#given a landing file that holds this session's sealed predecessor #then prepare readies the move and leaves that file as it was", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-earlier");
		const sealed = place(landingIn(fixture.repoB, fixture), readFileSync(fixture.sessionPath, "utf8"));
		expect(sessionOwnership(loadEntriesFromFile(landingIn(fixture.repoB, fixture))).writable).toBe(false);

		const readied = await prepare(b, fixture, "move-o3");

		expect(readied).toMatchObject(READY);
		expect(readFileSync(landingIn(fixture.repoB, fixture), "utf8")).toBe(sealed);
	});

	it("#given no landing file #then a prepare that names the session readies the move", async () => {
		const fixture = await devices();
		await using b = createInProcessRig(fixture.agentB);

		expect(await prepare(b, fixture, "move-o4")).toMatchObject(READY);
		expect(existsSync(landingIn(fixture.repoB, fixture))).toBe(false);
		// It only reads: readying a move creates no session folder either. The import makes it when it lands.
		expect(existsSync(sessionFolder(fixture.repoB, fixture))).toBe(false);
	});

	it("#given an occupied landing file #when prepare does not name the session #then the move is readied as before and the import refuses it as before", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const before = place(landingIn(fixture.repoB, fixture), anotherSession(fixture));

		const readied = await move(b, {
			op: "prepare",
			moveId: "move-o5",
			cwd: fixture.repoB,
			repository: identity(fixture),
		});
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-o5");
		const bundle = await move(a, {
			op: "export",
			sessionPath: fixture.sessionPath,
			moveId: "move-o5",
			target: "device-b",
		});
		const imported = await move(b, {
			op: "import",
			cwd: fixture.repoB,
			bundleDir: (bundle.data as { bundle_dir: string }).bundle_dir,
		});

		expect(readied).toMatchObject(READY);
		expect(imported).toMatchObject(refusedWith("move_target_occupied"));
		expect(readFileSync(landingIn(fixture.repoB, fixture), "utf8")).toBe(before);
	});

	it("#given a sessionDir #then prepare looks for the landing file there and not in the default folder", async () => {
		const fixture = await devices();
		await using b = createInProcessRig(fixture.agentB);
		const elsewhere = join(fixture.base, "elsewhere");
		mkdirSync(elsewhere);
		place(landingIn(fixture.repoB, fixture), anotherSession(fixture));

		const free = await prepare(b, fixture, "move-o6-free", { sessionDir: elsewhere });
		place(join(elsewhere, fileName(fixture)), anotherSession(fixture));
		const occupied = await prepare(b, fixture, "move-o6-occupied", { sessionDir: elsewhere });

		expect(free).toMatchObject(READY);
		expect(occupied).toMatchObject(refusedWith("move_target_occupied"));
		expect(existsSync(ledgerFile(fixture.agentB, "move-o6-occupied"))).toBe(false);
	});

	it.each([
		["a session without cwd", () => ({ cwd: undefined, repository: undefined })],
		["a session that is not an object", () => ({ session: "plain" })],
		[
			"a file name with a folder in it",
			(fixture: Fixture) => ({ session: { id: SESSION_ID, fileName: `sub/${fileName(fixture)}` } }),
		],
		[
			"a file name that climbs out",
			(fixture: Fixture) => ({ session: { id: SESSION_ID, fileName: `..${fileName(fixture)}` } }),
		],
		[
			"a session id that is not plain",
			(fixture: Fixture) => ({ session: { id: "../escape", fileName: fileName(fixture) } }),
		],
		["a sessionDir that is a file", (fixture: Fixture) => ({ sessionDir: fixture.sessionPath })],
		["a sessionDir without a session", () => ({ session: undefined, sessionDir: "/somewhere" })],
	])("#given %s #then prepare refuses invalid_move_request and readies nothing", async (_case, fields) => {
		const fixture = await devices();
		await using b = createInProcessRig(fixture.agentB);

		const refused = await prepare(b, fixture, "move-o7", fields(fixture));

		expect(refused).toMatchObject(refusedWith("invalid_move_request"));
		expect(existsSync(ledgerFile(fixture.agentB, "move-o7"))).toBe(false);
	});

	it("#given a folder of another repository whose landing file is also occupied #then the repository refusal comes first", async () => {
		const fixture = await devices();
		const other = unrelatedRepo(join(fixture.base, "other"));
		await using b = createInProcessRig(fixture.agentB);
		place(landingIn(other, fixture), anotherSession(fixture));

		const refused = await prepare(b, fixture, "move-o8", { cwd: other });

		expect(refused).toMatchObject(refusedWith("move_repository_mismatch"));
		expect(existsSync(ledgerFile(fixture.agentB, "move-o8"))).toBe(false);
	});

	it("#given a folder of another repository with no session folder yet #when prepare names the session and is refused #then no session folder is left behind for that folder", async () => {
		const fixture = await devices();
		const other = unrelatedRepo(join(fixture.base, "other"));
		await using b = createInProcessRig(fixture.agentB);
		expect(existsSync(sessionFolder(other, fixture))).toBe(false);

		const refused = await prepare(b, fixture, "move-o9", { cwd: other });

		expect(refused).toMatchObject(refusedWith("move_repository_mismatch"));
		expect(existsSync(sessionFolder(other, fixture))).toBe(false);
	});
});
