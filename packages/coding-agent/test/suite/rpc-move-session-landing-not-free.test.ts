/**
 * A landing place that is not free (follow-up to senpi#6471). `prepare` and the import ask one question about the place
 * a moved session would land in. Only a name that is not there is free. A place that cannot be looked at is not free,
 * and neither is a file there that holds no session: both keep the place, and the import never replaces them.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDirPath } from "../../src/core/session-manager.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move, type Rig } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

type Fixture = Awaited<ReturnType<typeof devices>>;

const READY = { success: true, command: "move_session", data: { state: "ready" } };
const NOT_DONE = { success: false, command: "move_session" };
const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);
const landing = (fixture: Fixture) =>
	join(getDefaultSessionDirPath(fixture.repoB, fixture.agentB), basename(fixture.sessionPath));
const identity = (fixture: Fixture) => ({ rootCommits: [fixture.root] });

/** Names that are there and cannot be read as a file. Looking through them fails; the name is taken all the same. */
const LINKS = [
	["a link that leads back to itself", (at: string) => symlinkSync(at, at)],
	["a link that leads nowhere", (at: string) => symlinkSync(join(dirname(at), "nowhere"), at)],
] as const;

function placeLink(at: string, make: (at: string) => void): void {
	mkdirSync(dirname(at), { recursive: true });
	make(at);
}

function place(at: string, text: string): void {
	mkdirSync(dirname(at), { recursive: true });
	writeFileSync(at, text);
}

const prepareNamed = (b: Rig, fixture: Fixture, moveId: string) =>
	move(b, {
		op: "prepare",
		moveId,
		cwd: fixture.repoB,
		repository: identity(fixture),
		session: { id: SESSION_ID, fileName: basename(fixture.sessionPath) },
	});

/** A move readied without naming its session, so nothing looks at the landing place before the import does. */
async function importInto(a: Rig, b: Rig, fixture: Fixture, moveId: string) {
	const readied = await move(b, { op: "prepare", moveId, cwd: fixture.repoB, repository: identity(fixture) });
	expect(readied).toMatchObject(READY);
	await hostAndRelease(a, fixture.repoA, fixture.sessionPath, moveId);
	const bundle = await move(a, { op: "export", sessionPath: fixture.sessionPath, moveId, target: "device-b" });
	return move(b, { op: "import", cwd: fixture.repoB, bundleDir: (bundle.data as { bundle_dir: string }).bundle_dir });
}

const NO_SESSION = [
	["an empty file", ""],
	["text that is no session", "not a session\n"],
	["an entry with no session header", `${JSON.stringify({ type: "message", id: "m1" })}\n`],
] as const;

// senpi#6471
describe.skipIf(process.platform === "win32")("a landing place that cannot be looked at is not free", () => {
	it.each(LINKS)(
		"#given a landing place that holds %s #when prepare names the session #then the move is not readied and the place is left as it was",
		async (_case, make) => {
			const fixture = await devices();
			await using b = createInProcessRig(fixture.agentB);
			placeLink(landing(fixture), make);

			const answer = await prepareNamed(b, fixture, "move-u1");

			expect(answer).toMatchObject(NOT_DONE);
			expect(existsSync(ledgerFile(fixture.agentB, "move-u1"))).toBe(false);
			expect(lstatSync(landing(fixture)).isSymbolicLink()).toBe(true);
		},
	);

	it.each(LINKS)(
		"#given a landing place that holds %s #when the bundle is imported #then the import does not land and does not replace what stands there",
		async (_case, make) => {
			const fixture = await devices();
			await using a = createInProcessRig(fixture.agentA);
			await using b = createInProcessRig(fixture.agentB);
			placeLink(landing(fixture), make);

			const imported = await importInto(a, b, fixture, "move-u2");

			expect(imported).toMatchObject(NOT_DONE);
			expect(lstatSync(landing(fixture)).isSymbolicLink()).toBe(true);
		},
	);

	it("#given a session folder path that is a file, so the landing place cannot be looked at #when prepare names the session #then the move is not readied", async () => {
		const fixture = await devices();
		await using b = createInProcessRig(fixture.agentB);
		const folder = dirname(landing(fixture));
		mkdirSync(dirname(folder), { recursive: true });
		writeFileSync(folder, "not a folder\n");

		const answer = await prepareNamed(b, fixture, "move-u3");

		expect(answer).toMatchObject(NOT_DONE);
		expect(existsSync(ledgerFile(fixture.agentB, "move-u3"))).toBe(false);
		expect(readFileSync(folder, "utf8")).toBe("not a folder\n");
	});
});

describe("a landing file that holds no session keeps the place", () => {
	it.each(NO_SESSION)(
		"#given a landing file that is %s #when prepare names the session #then the move is not readied and the file is left as it was",
		async (_case, text) => {
			const fixture = await devices();
			await using b = createInProcessRig(fixture.agentB);
			place(landing(fixture), text);

			const answer = await prepareNamed(b, fixture, "move-n1");

			expect(answer).toMatchObject(NOT_DONE);
			expect(existsSync(ledgerFile(fixture.agentB, "move-n1"))).toBe(false);
			expect(readFileSync(landing(fixture), "utf8")).toBe(text);
		},
	);

	it.each(NO_SESSION)(
		"#given a landing file that is %s #when the bundle is imported #then the import does not land and the file is left as it was",
		async (_case, text) => {
			const fixture = await devices();
			await using a = createInProcessRig(fixture.agentA);
			await using b = createInProcessRig(fixture.agentB);
			place(landing(fixture), text);

			const imported = await importInto(a, b, fixture, "move-n2");

			expect(imported).toMatchObject(NOT_DONE);
			expect(readFileSync(landing(fixture), "utf8")).toBe(text);
		},
	);
});
