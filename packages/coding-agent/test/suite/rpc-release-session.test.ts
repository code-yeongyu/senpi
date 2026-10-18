/**
 * `release_session` on the in-process runtime: the real router, registry and writer over a real
 * `SessionManager`, with turns the test drives. A released session is gone from the host and its file
 * opens standalone exactly as `senpi --session <path>` opens it; every refusal leaves the host owning
 * the session unchanged.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig, type FakeTurn } from "./rpc-inprocess-host-support.ts";

const scratches: string[] = [];

afterEach(async () => {
	await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function rigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-release-"));
	scratches.push(dir);
	return dir;
}

type Rig = ReturnType<typeof createInProcessRig>;

/** One retained session with a settled exchange on disk, opened by `conn-a`. */
async function openExchange(rig: Rig, dir: string, name: string) {
	const session = opened(
		await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, `${name}.jsonl`), retain_on_disconnect: true }),
		0,
	);
	const turn: FakeTurn | undefined = rig.turns.get(session.state.sessionFile);
	if (!turn) throw new Error("no turn control for the opened session");
	turn.start();
	turn.finish();
	return { sessionId: session.sessionId, sessionPath: session.state.sessionFile, turn };
}

async function release(
	rig: Rig,
	sessionId: string,
	fields: Partial<Extract<RpcCommand, { type: "release_session" }>> = {},
): Promise<Record<string, unknown>> {
	const response = await rig.router.handle({
		type: "release_session",
		id: "rel",
		sessionId,
		reason: "takeover",
		...fields,
	});
	await rig.settle();
	if (response === undefined) throw new Error("release_session answered nothing");
	return { ...response };
}

function standaloneEntries(sessionPath: string) {
	return SessionManager.open(sessionPath).getEntries();
}

describe("release_session", () => {
	it("hands an idle, detached session over: the host drops it and its file opens standalone", async () => {
		// Given: a retained session with one exchange, whose only client detached.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const { sessionId, sessionPath } = await openExchange(rig, dir, "idle");
		await rig.drop("conn-a");
		await rig.open("conn-b", { cwd: dir });

		// When: the session is released for a takeover.
		const reply = await release(rig, sessionId);

		// Then: the host answers with the file, lists the session no more, and says why it went away.
		expect(reply).toMatchObject({
			success: true,
			command: "release_session",
			data: { released: true, session_path: sessionPath, attachments: 0 },
		});
		expect((await rig.list()).map((row) => row.sessionPath)).not.toContain(sessionPath);
		expect(rig.recordsFor("conn-b")).toContainEqual({
			type: "session_closed",
			sessionId,
			reason: "released",
			sessionPath,
		});
		// And: the same JSONL opens standalone, holding the exchange and the release bookkeeping entry.
		const entries = standaloneEntries(sessionPath);
		expect(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
		const released = entries.filter(
			(entry) => entry.type === "custom" && entry.customType === SESSION_RELEASED_ENTRY_TYPE,
		);
		expect(released).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ reason: "takeover", interrupted: false, attachments: 0 }),
			}),
		]);
	});

	it("refuses mid-turn with turn_active, lets the turn finish, and keeps the session on the host", async () => {
		// Given: a detached session running a turn.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const { sessionId, sessionPath, turn } = await openExchange(rig, dir, "busy");
		await rig.drop("conn-a");
		turn.start();

		// When: a release arrives while the turn streams.
		const reply = await release(rig, sessionId);

		// Then: refused, nothing aborted, and the turn completes on the host that still owns the path.
		expect(reply).toMatchObject({ success: false, error: "turn_active" });
		expect(turn.aborted).toBe(false);
		turn.finish();
		await rig.settle();
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId, sessionPath, status: "open" })]);
		expect(
			standaloneEntries(sessionPath).filter(
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			),
		).toHaveLength(2);
		expect(
			standaloneEntries(sessionPath).some(
				(entry) => entry.type === "custom" && entry.customType === SESSION_RELEASED_ENTRY_TYPE,
			),
		).toBe(false);
	});

	it("aborts the turn first and then releases when interrupt is set", async () => {
		// Given: a detached session running a turn.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const { sessionId, sessionPath, turn } = await openExchange(rig, dir, "interrupt");
		await rig.drop("conn-a");
		turn.start();

		// When: the release asks for an interrupt.
		const reply = await release(rig, sessionId, { interrupt: true });

		// Then: the run was aborted, the session released, and the bookkeeping entry says it was interrupted.
		expect(turn.aborted).toBe(true);
		expect(reply).toMatchObject({ success: true, data: { released: true, session_path: sessionPath } });
		expect(await rig.list()).toEqual([]);
		expect(
			standaloneEntries(sessionPath).filter(
				(entry) => entry.type === "custom" && entry.customType === SESSION_RELEASED_ENTRY_TYPE,
			),
		).toEqual([expect.objectContaining({ data: expect.objectContaining({ interrupted: true }) })]);
	});

	it("refuses while a client is attached unless force, and force tells that client it was released", async () => {
		// Given: a session its opener is still attached to.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const { sessionId, sessionPath } = await openExchange(rig, dir, "attached");

		// When / Then: a plain release names the attachment count and changes nothing.
		expect(await release(rig, sessionId)).toMatchObject({
			success: false,
			error: "attached",
			errorData: { attachments: 1 },
		});
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId, attachments: 1 })]);

		// When / Then: a forced release goes through and the attached client learns not to reopen it here.
		expect(await release(rig, sessionId, { force: true })).toMatchObject({
			success: true,
			data: { released: true, session_path: sessionPath, attachments: 1 },
		});
		expect(rig.recordsFor("conn-a")).toContainEqual({
			type: "session_closed",
			sessionId,
			reason: "released",
			sessionPath,
		});
		expect(await rig.list()).toEqual([]);
	});

	it("answers unknown_session for a second release and invalid_release_reason for another reason", async () => {
		// Given: a session released once.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const first = await openExchange(rig, dir, "twice");
		const other = await openExchange(rig, dir, "reason");
		await rig.drop("conn-a");
		expect(await release(rig, first.sessionId)).toMatchObject({ success: true });

		// When / Then: the handle no longer resolves, and a reason other than takeover is refused untouched.
		expect(await release(rig, first.sessionId)).toMatchObject({ success: false, error: "unknown_session" });
		const wrongReason = { reason: "evict" } as unknown as Partial<Extract<RpcCommand, { type: "release_session" }>>;
		expect(await release(rig, other.sessionId, wrongReason)).toMatchObject({
			success: false,
			error: "invalid_release_reason",
		});
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: other.sessionId, status: "open" })]);
	});
});
