/**
 * `move_session` op `identity` (senpi#6435) takes a path from the caller, so its reach and standing are pinned here
 * (a security contract of the RPC host). It reads only a session file inside this host's own session folder, answers
 * one refusal for every path it will not read (so it cannot tell a caller which paths exist), reads a bounded amount,
 * answers the repository identity and nothing else, and needs what every `move_session` op needs on a delegated
 * connection.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE } from "../../src/core/repository-identity.ts";
import { declare, startHost } from "./rpc-delegated-host-support.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, move } from "./rpc-move-session-support.ts";

const ROOT_OLD = "a".repeat(40);
const ROOT_NEW = "b".repeat(40);
/** The documented bound (docs/rpc.md, a protocol contract): identity scans a session file of at most 1 GiB. */
const SCAN_LIMIT_BYTES = 1024 ** 3;

const identityEntry = (id: string, parentId: string | null, data: unknown) => ({
	type: "custom",
	id,
	parentId,
	timestamp: "2026-10-19T00:00:00.500Z",
	customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
	data,
});
const userEntry = (id: string, parentId: string | null, content: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-19T00:00:01.000Z",
	message: { role: "user", content, timestamp: 1 },
});

function writeSession(dir: string, sessionId: string, entries: readonly unknown[]): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-10-19T00-00-00-000Z_${sessionId}.jsonl`);
	const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-10-19T00:00:00.000Z", cwd: dir };
	writeFileSync(file, `${[header, ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

// senpi#6435
describe("move_session identity reads only this host's session files (senpi#6435)", () => {
	it("#given a session file that records two identities, other entries and one very long line #then identity answers the newest identity and nothing else, and changes nothing", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		const newest = { rootCommits: [ROOT_NEW], originUrl: "example.com/owner/repo" };
		const file = writeSession(dirname(fixture.sessionPath), "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e1", [
			identityEntry("r1", null, { rootCommits: [ROOT_OLD] }),
			userEntry("u1", "r1", "the first prompt"),
			userEntry("u2", "u1", "x".repeat(3 * 1024 * 1024)),
			identityEntry("r2", "u2", newest),
			userEntry("u3", "r2", `a prompt that only mentions "${REPOSITORY_IDENTITY_ENTRY_TYPE}"`),
		]);
		const before = readFileSync(file, "utf8");

		const answer = await move(a, { op: "identity", sessionPath: file });

		expect(answer).toEqual({
			id: "mv",
			type: "response",
			command: "move_session",
			success: true,
			data: { repository: newest },
		});
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(existsSync(join(fixture.agentA, "session-moves"))).toBe(false);
	});

	it.runIf(process.platform !== "win32")(
		"#given a path with no file, session files outside this host's session folder, and files inside it that are not session files #then identity answers every one the same refusal and opens none of the outside ones",
		async () => {
			const fixture = await devices();
			await using a = createInProcessRig(fixture.agentA);
			const sessionDir = dirname(fixture.sessionPath);
			const entries = [identityEntry("r1", null, { rootCommits: [ROOT_NEW] }), userEntry("u1", "r1", "hello")];
			// A real session with a recorded identity, but in another agent directory: reading it would answer it.
			const outside = writeSession(join(fixture.agentB, "sessions", "--elsewhere--"), "outside-1", entries);
			const linked = join(sessionDir, "2026-10-19T00-00-00-000Z_linked-1.jsonl");
			symlinkSync(outside, linked);
			// Opening a pipe for reading never returns while nothing writes to it.
			const outsidePipe = join(fixture.base, "outside.jsonl");
			const insidePipe = join(sessionDir, "2026-10-19T00-00-00-000Z_pipe-1.jsonl");
			for (const pipe of [outsidePipe, insidePipe]) execFileSync("mkfifo", [pipe]);
			const notASession = join(sessionDir, "2026-10-19T00-00-00-000Z_notes-1.jsonl");
			writeFileSync(notASession, `${JSON.stringify({ rootCommits: [ROOT_NEW] })}\n`);
			const sidecar = join(sessionDir, "extensions", "goal", "sidecar-1.json");
			mkdirSync(dirname(sidecar), { recursive: true });
			writeFileSync(sidecar, `${JSON.stringify({ type: "session", id: "sidecar-1" })}\n`);
			const folder = join(sessionDir, "2026-10-19T00-00-00-000Z_folder-1.jsonl");
			mkdirSync(folder);

			const missing = await move(a, { op: "identity", sessionPath: join(sessionDir, "no-such-session.jsonl") });
			const refusals = [];
			const climbing = [sessionDir, "..", "..", "..", "agent-b", "sessions", "--elsewhere--"].join(sep);
			for (const sessionPath of [
				outside,
				`${climbing}${sep}${basename(outside)}`,
				`${climbing}${sep}no-such-session.jsonl`,
				linked,
				outsidePipe,
				insidePipe,
				notASession,
				sidecar,
				folder,
				sessionDir,
			])
				refusals.push(await move(a, { op: "identity", sessionPath }));

			expect(missing).toEqual({
				id: "mv",
				type: "response",
				command: "move_session",
				success: false,
				error: "move_failed",
				errorCode: "move_failed",
				errorData: { detail: expect.any(String) },
			});
			expect(refusals).toEqual(refusals.map(() => missing));
			expect(existsSync(join(fixture.agentA, "session-moves"))).toBe(false);
		},
		15_000,
	);

	it.runIf(process.platform !== "win32")(
		"#given a session file larger than the identity read scans #then identity is refused instead of reading it",
		async () => {
			const fixture = await devices();
			await using a = createInProcessRig(fixture.agentA);
			const file = writeSession(dirname(fixture.sessionPath), "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e2", [
				identityEntry("r1", null, { rootCommits: [ROOT_NEW] }),
				userEntry("u1", "r1", "hello"),
			]);
			expect(await move(a, { op: "identity", sessionPath: file })).toMatchObject({ success: true });
			// A hole, not written bytes: the file only reports the size.
			truncateSync(file, SCAN_LIMIT_BYTES + 1);

			const answer = await move(a, { op: "identity", sessionPath: file });

			expect(answer).toMatchObject({ success: false, errorCode: "move_failed" });
		},
	);

	it("#given an identity request #then it needs sessionPath and no moveId, and a missing or empty sessionPath is refused invalid_move_request", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);

		expect(await move(a, { op: "identity", sessionPath: fixture.sessionPath })).toMatchObject({
			success: true,
			data: { repository: { rootCommits: [fixture.root] } },
		});
		for (const sessionPath of ["", "   ", undefined, 7])
			expect(await move(a, { op: "identity", sessionPath })).toMatchObject({
				success: false,
				errorCode: "invalid_move_request",
			});
	});

	it("#given the folder form #when it names a checkout and then a folder with no repository, one that is not there, a file and an unreadable folder #then only the checkout answers an identity and the rest answer one and the same empty answer", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		const plain = join(fixture.base, "plain");
		mkdirSync(plain, { recursive: true });
		const file = join(fixture.base, "a-file");
		writeFileSync(file, "not a folder\n");
		const unreadable = join(fixture.base, "unreadable");
		mkdirSync(unreadable, { recursive: true });
		const root = typeof process.getuid === "function" && process.getuid() === 0;
		if (!root) chmodSync(unreadable, 0o000);

		try {
			const checkout = await move(a, { op: "identity", cwd: fixture.repoA });
			const empty = [];
			for (const cwd of [plain, join(fixture.base, "not-there"), file, ...(root ? [] : [unreadable])])
				empty.push(await move(a, { op: "identity", cwd }));

			expect(checkout).toMatchObject({ success: true, data: { repository: { rootCommits: [fixture.root] } } });
			// One answer for every folder that names no repository: the op never says which folders are there.
			expect(empty).toEqual(
				empty.map(() => ({ id: "mv", type: "response", command: "move_session", success: true, data: {} })),
			);
		} finally {
			if (!root) chmodSync(unreadable, 0o700);
		}
	});

	it("#given an identity request that names both forms or neither #then it is refused invalid_move_request", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);

		for (const fields of [{ sessionPath: fixture.sessionPath, cwd: fixture.repoA }, {}, { cwd: "work/repo" }])
			expect(await move(a, { op: "identity", ...fields })).toMatchObject({
				success: false,
				errorCode: "invalid_move_request",
			});
	});

	it("#given a delegated connection #when it is granted everything but device_admin #then identity is refused like every move_session op, the same for a session file and for a path with no file, and with device_admin it answers", async () => {
		const host = await startHost();
		try {
			const sessionDir = join(host.scratch, "agent", "sessions", "--work--");
			const file = writeSession(sessionDir, "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e3", [
				identityEntry("r1", null, { rootCommits: [ROOT_NEW] }),
				userEntry("u1", "r1", "hello"),
			]);
			const viewer = await host.proven();
			const admin = await host.proven();
			expect(await declare(viewer, ["observe", "drive", "answer", "thread"])).toMatchObject({ success: true });
			expect(await declare(admin, ["device_admin"])).toMatchObject({ success: true });
			const refusal = { success: false, errorCode: "delegation_local_only", errorData: { class: "device_admin" } };

			const known = await viewer.send({ type: "move_session", op: "identity", sessionPath: file });
			const unknown = await viewer.send({
				type: "move_session",
				op: "identity",
				sessionPath: join(sessionDir, "no-such-session.jsonl"),
			});
			const allowed = await admin.send({ type: "move_session", op: "identity", sessionPath: file });

			expect(known).toMatchObject(refusal);
			expect({ ...unknown, id: known.id }).toEqual(known);
			expect(allowed).toMatchObject({ success: true, data: { repository: { rootCommits: [ROOT_NEW] } } });
		} finally {
			await host.dispose();
		}
	}, 60_000);
});
