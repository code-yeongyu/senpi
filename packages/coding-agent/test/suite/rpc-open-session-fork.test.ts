/**
 * omo#13031: `open_session { forkFrom }` forks a session this engine can read, through `SessionManager.forkFrom`, and
 * answers like any open: a new durable id whose history is the source's up to the fork point, while the source's file
 * is left exactly as it was. A source this engine cannot read is refused, typed, and nothing is opened: an id no session
 * file of this host carries is `fork_source_not_local` (it may live on another device or agent dir), a path with no
 * readable session file is `fork_source_not_found`. Never a plain new session.
 *
 * Runs on the bare host's per-connection dispatch over a real socket with a real runtime
 * (`rpc-delegated-host-support.ts`), in both runtimes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { type DelegatedHost, type Peer, startHost } from "./rpc-delegated-host-support.ts";

interface Opened {
	readonly sessionId: string;
	readonly state: { readonly sessionId: string; readonly sessionFile?: string };
}

const SOURCE_ID = "0199f0d4-1303-7000-8000-000000000001";
const FORK_ID = "0199f0d4-1303-7000-8000-0000000000f1";
const UNKNOWN_ID = "0199f0d4-1303-7000-8000-0000000000ff";

const message = (id: string, parentId: string | null, text: string, second: number) => ({
	type: "message",
	id,
	parentId,
	timestamp: `2026-11-19T00:00:0${second}.000Z`,
	message: { role: "user", content: text, timestamp: second },
});

describe.each<[string, { readonly workers?: boolean }]>([
	["the in-process runtime", {}],
	["the worker runtime", { workers: true }],
])("open_session forkFrom, on %s (omo#13031)", (_runtime, hostOptions) => {
	let host: DelegatedHost;
	let peer: Peer;
	let agentDir: string;
	let sourceFile: string;

	beforeAll(async () => {
		host = await startHost(hostOptions);
		peer = await host.proven();
		agentDir = join(host.scratch, "agent");
		const dir = getDefaultSessionDir(host.cwd, agentDir);
		mkdirSync(dir, { recursive: true });
		sourceFile = join(dir, `2026-11-19T00-00-00-000Z_${SOURCE_ID}.jsonl`);
		const lines = [
			{ type: "session", version: 3, id: SOURCE_ID, timestamp: "2026-11-19T00:00:00.000Z", cwd: host.cwd },
			message("u1", null, "remember 42", 1),
			message("u2", "u1", "and remember 43", 2),
			message("u3", "u2", "the fork point is here", 3),
		];
		writeFileSync(sourceFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	});
	afterAll(async () => {
		await host.dispose();
	});

	const texts = async (sessionId: string): Promise<string[]> => {
		const { messages } = (await peer.send({ type: "get_messages", sessionId })).data as {
			messages: Array<{ role: string; content: unknown }>;
		};
		return messages.filter((entry) => entry.role === "user").map((entry) => String(entry.content));
	};
	const listedPaths = async (): Promise<Array<string | undefined>> =>
		((await peer.send({ type: "list_sessions" })).data as { sessions: Array<{ sessionPath?: string }> }).sessions.map(
			(row) => row.sessionPath,
		);

	it("#given a session file of this host #when open_session forks it by its durable id #then a new session answers with a new durable id and the source's history, and the source file is unchanged", async () => {
		const before = readFileSync(sourceFile, "utf8");

		const forked = await peer.send({ type: "open_session", forkFrom: SOURCE_ID });

		expect(forked).toMatchObject({ success: true });
		const opened = forked.data as Opened;
		expect(opened.state.sessionId).not.toBe(SOURCE_ID);
		expect(await texts(opened.sessionId)).toEqual(["remember 42", "and remember 43", "the fork point is here"]);
		expect(readFileSync(sourceFile, "utf8")).toBe(before);
		const header = JSON.parse(readFileSync(String(opened.state.sessionFile), "utf8").split("\n")[0] ?? "{}") as {
			parentSession?: string;
		};
		expect(header.parentSession).toBe(sourceFile);
	});

	it("#given the same file #when open_session forks it by its path and names the fork's durable id #then the fork carries that id and the source's history", async () => {
		const forked = await peer.send({ type: "open_session", forkFrom: sourceFile, durableSessionId: FORK_ID });

		expect(forked).toMatchObject({ success: true, data: { state: { sessionId: FORK_ID } } });
		expect(await texts((forked.data as Opened).sessionId)).toEqual([
			"remember 42",
			"and remember 43",
			"the fork point is here",
		]);
	});

	it("#given an id no session file of this host carries #when open_session forks it #then fork_source_not_local and nothing is opened", async () => {
		const listed = await listedPaths();

		const refused = await peer.send({ type: "open_session", forkFrom: UNKNOWN_ID });

		expect(refused).toMatchObject({
			success: false,
			error: "fork_source_not_local",
			errorData: { forkFrom: UNKNOWN_ID },
		});
		expect(await listedPaths()).toEqual(listed);
	});

	it("#given a path with no session file #when open_session forks it #then fork_source_not_found and nothing is opened", async () => {
		const missing = join(host.scratch, "nowhere", "gone.jsonl");
		const listed = await listedPaths();

		const refused = await peer.send({ type: "open_session", forkFrom: missing });

		expect(refused).toMatchObject({ success: false, error: "fork_source_not_found", errorData: { forkFrom: missing } });
		expect(await listedPaths()).toEqual(listed);
	});

	it("#given forkFrom and a sessionPath together #when open_session runs #then invalid_launch_profile and nothing is opened", async () => {
		const refused = await peer.send({
			type: "open_session",
			forkFrom: SOURCE_ID,
			sessionPath: join(host.scratch, "other.jsonl"),
		});

		expect(refused).toMatchObject({ success: false, error: expect.stringContaining("invalid_launch_profile") });
	});

	it("#given this host #when get_protocol_info is read #then it advertises open_session_fork", async () => {
		const info = await peer.send({ type: "get_protocol_info" });

		expect((info.data as { capabilities: string[] }).capabilities).toContain("open_session_fork");
	});
});
