/**
 * `find_session` (senpi#6429): a read-only lookup of a session FILE by the durable id, for a client whose session is
 * closed and unlisted, so the routing key it holds names nothing. It reads this host's own session folder only, never
 * a path from the request, opens and claims nothing, is bounded, and needs what an `open_session` of that path needs,
 * so a caller without that standing cannot tell a known id from an unknown one.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { findSession } from "../../src/modes/rpc/find-session.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { declare, startHost } from "./rpc-delegated-host-support.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices } from "./rpc-move-session-support.ts";

type Rig = ReturnType<typeof createInProcessRig>;

// Never the fixture's own session id: that file is already on disk, and two files with one id answer ambiguous.
const ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e5";
const OTHER_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d7";

function writeSessionFile(dir: string, id: string, stamp = "2026-11-11T00-00-00-000Z"): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${stamp}_${id}.jsonl`);
	writeFileSync(
		file,
		`${[
			{ type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd: dir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-11-11T00:00:01.000Z",
				message: { role: "user", content: "remember 42", timestamp: 1 },
			},
		]
			.map((line) => JSON.stringify(line))
			.join("\n")}\n`,
	);
	return file;
}

async function find(rig: Rig, durableSessionId: unknown): Promise<Record<string, unknown>> {
	const response = await rig.router.handle({ type: "find_session", id: "fs", durableSessionId } as RpcCommand);
	await rig.settle();
	if (response === undefined) throw new Error("find_session answered nothing");
	return { ...response };
}

// senpi#6429
describe("find_session finds a session file by its durable id (senpi#6429)", () => {
	it("#given a session file that exists on disk and is not open on an in-process multi-session host #when find_session names its durable id #then the answer is the file's path and its header's cwd, the session is still not listed, and the file's bytes are unchanged", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);
		const dir = getDefaultSessionDir(fixture.repoA, fixture.agentA);
		const file = writeSessionFile(dir, ID);
		const before = readFileSync(file, "utf8");

		const answer = await find(host, ID);

		expect(answer).toEqual({
			id: "fs",
			type: "response",
			command: "find_session",
			success: true,
			data: { found: { sessionPath: file, cwd: dir, open: false } },
		});
		expect(await host.list()).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("#given two session files that carry one durable id #then the answer is ambiguous and names neither", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);
		writeSessionFile(getDefaultSessionDir(fixture.repoA, fixture.agentA), ID);
		writeSessionFile(getDefaultSessionDir(fixture.repoB, fixture.agentA), ID, "2026-11-11T01-00-00-000Z");

		expect(await find(host, ID)).toMatchObject({ success: true, data: { ambiguous: true } });
		expect(JSON.stringify(await find(host, ID))).not.toContain(".jsonl");
	});

	it("#given a durable id no session file carries #then the answer is unknown", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);
		writeSessionFile(getDefaultSessionDir(fixture.repoA, fixture.agentA), ID);

		expect(await find(host, OTHER_ID)).toMatchObject({ success: true, data: { unknown: true } });
	});

	it("#given a session this host has open #then the answer names its file and says an engine holds it", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);
		const session = opened(
			await host.open("conn-a", {
				cwd: fixture.repoA,
				sessionPath: fixture.sessionPath,
				retain_on_disconnect: true,
			}),
			0,
		);

		const answer = await find(host, session.state.sessionId);

		expect(answer).toMatchObject({
			success: true,
			data: { found: { sessionPath: fixture.sessionPath, cwd: fixture.repoA, open: true } },
		});
	});

	it("#given a request with no durable id, an empty one or one that is not a string #then it is refused and nothing is scanned", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);

		for (const durableSessionId of [undefined, "", "   ", 7])
			expect(await find(host, durableSessionId)).toMatchObject({ success: false, errorCode: "invalid_argument" });
	});

	it("#given more session files than one find_session reads #then it answers a typed error instead of a partial answer", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);
		const dir = getDefaultSessionDir(fixture.repoA, fixture.agentA);
		writeSessionFile(dir, ID);
		const crowd = join(fixture.agentA, "sessions", "--crowd--");
		mkdirSync(crowd, { recursive: true });
		for (let index = 0; index <= 20_000; index += 1) writeFileSync(join(crowd, `f${index}.jsonl`), "");

		const answer = await find(host, ID);

		expect(answer).toMatchObject({ success: false, errorCode: "find_session_too_many" });
		rmSync(crowd, { recursive: true, force: true });
	}, 120_000);

	it("#given a delegated connection without device_admin #then find_session is refused, and a known and an unknown id are refused the same way", async () => {
		const host = await startHost();
		try {
			const sessionDir = join(host.scratch, "agent", "sessions", "--work--");
			writeSessionFile(sessionDir, ID);
			const viewer = await host.proven();
			const admin = await host.proven();
			expect(await declare(viewer, ["observe", "drive", "answer", "thread"])).toMatchObject({ success: true });
			expect(await declare(admin, ["device_admin"])).toMatchObject({ success: true });

			const known = await viewer.send({ type: "find_session", durableSessionId: ID });
			const unknown = await viewer.send({ type: "find_session", durableSessionId: OTHER_ID });
			const allowed = await admin.send({ type: "find_session", durableSessionId: ID });

			expect(known).toMatchObject({ success: false, errorData: { class: "device_admin" } });
			expect({ ...unknown, id: known.id }).toEqual(known);
			expect(allowed).toMatchObject({ success: true, data: { found: { cwd: sessionDir, open: false } } });
		} finally {
			await host.dispose();
		}
	}, 60_000);

	it("#given an agent directory with no session folder at all #then the answer is unknown and nothing is created", async () => {
		const fixture = await devices();
		const empty = join(fixture.base, "agent-empty");
		await using host = createInProcessRig(empty);

		expect(await find(host, ID)).toMatchObject({ success: true, data: { unknown: true } });
		expect(existsSync(join(empty, "sessions"))).toBe(false);
	});

	it("#given a host that keeps no agent directory #then find_session is refused find_session_unsupported", async () => {
		const answer = await findSession({ agentDir: undefined, hosted: () => [] }, { id: "fs", durableSessionId: ID });

		expect(answer).toMatchObject({
			id: "fs",
			command: "find_session",
			success: false,
			errorCode: "find_session_unsupported",
		});
	});

	it("#given a file whose first line does not end within the bytes a header may take #then it is not a candidate, even when those bytes alone read as a header", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);
		const dir = getDefaultSessionDir(fixture.repoA, fixture.agentA);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
		const header = JSON.stringify({ type: "session", version: 3, id: ID, cwd: dir });
		// The first 64 KiB are a whole header followed by spaces; the line itself runs on past them.
		writeFileSync(file, `${header}${" ".repeat(64 * 1024)}still the first line\n`);

		const answer = await find(host, ID);

		expect(answer).toMatchObject({ success: true, data: { unknown: true } });
	});

	it("#given a hosted session that names no file #then its file on disk still answers, and open stays false", async () => {
		const fixture = await devices();
		const dir = getDefaultSessionDir(fixture.repoA, fixture.agentA);
		const file = writeSessionFile(dir, ID);

		const answer = await findSession(
			{ agentDir: fixture.agentA, hosted: () => [{ durableSessionId: ID, cwd: dir }] },
			{ id: "fs", durableSessionId: ID },
		);

		expect(answer).toMatchObject({
			success: true,
			data: { found: { sessionPath: file, cwd: dir, open: false } },
		});
	});

	it("#given a session file whose header names no folder #then the answer names the file with an empty cwd", async () => {
		const fixture = await devices();
		await using host = createInProcessRig(fixture.agentA);
		const dir = getDefaultSessionDir(fixture.repoA, fixture.agentA);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: ID })}\n`);

		const answer = await find(host, ID);

		expect(answer).toMatchObject({ success: true });
		expect(answer.data).toEqual({ found: { sessionPath: file, cwd: "", open: false } });
	});
});
