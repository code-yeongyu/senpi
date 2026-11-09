/**
 * omo-relay-daemon#307, session-worker scope: every session runs in a real `node:worker_threads` isolate, and the
 * opener parks that isolate inside `/block` (a synchronous FIFO read) so a delegated peer's record is admitted on the
 * host but not yet checked in the worker. The baseline waits are what main also has (the narrowing's answer, the host's
 * `session_status` detach delta); the authority-word reads come after them as mechanism checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	attach,
	awaitWord,
	type DelegatedHost,
	declare,
	type OpenedSession,
	openSession,
	type Peer,
	startHost,
	type WireRecord,
} from "./rpc-delegated-host-support.ts";

const GRANT = ["observe", "drive", "thread"];
const BOTH = ["interactive_user", "task_parent"];
const VIEWER = { deviceId: "x307-device", deviceName: "Viewer" };
const NOT_INTERACTIVE = "hold_input_requires_interactive_client";

let host: DelegatedHost;
let opener: Peer;

beforeEach(() => {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
});
beforeAll(async () => {
	host = await startHost({ workers: true });
	opener = await host.proven();
	expect(await opener.send({ type: "set_client_info", capabilities: ["interactive_user"] })).toMatchObject({
		success: true,
	});
	expect(await opener.send({ type: "subscribe_sessions" })).toMatchObject({ success: true });
}, 60_000);
afterAll(async () => {
	await host.dispose();
}, 60_000);

const retained = () => openSession(opener, { retain_on_disconnect: true });

/** A host-mode peer attached to `session`; `claim` is declared host-level (none when empty). */
async function peerOn(session: OpenedSession, claim: readonly string[] = ["interactive_user"]): Promise<Peer> {
	const peer = await host.proven();
	expect(await declare(peer, GRANT, VIEWER, { roles: BOTH })).toMatchObject({ success: true });
	expect(await peer.send(attach(session))).toMatchObject({ success: true });
	if (claim.length > 0)
		expect(await peer.send({ type: "set_client_info", capabilities: claim })).toMatchObject({ success: true });
	return peer;
}

let inputs = 0;
function hold(session: OpenedSession, extra: WireRecord = {}): WireRecord {
	return {
		type: "hold_input",
		sessionId: session.sessionId,
		inputId: `x307w-${++inputs}`,
		revision: 0,
		text: "guidance",
		...extra,
	};
}

/** Parks the session's worker inside `/block`; resolves once the worker thread is blocked. */
async function block(session: OpenedSession) {
	const prompt = opener
		.send({ type: "prompt", sessionId: session.sessionId, message: "/block" })
		.catch(() => undefined);
	const gate = await host.blocked();
	return {
		async release() {
			await gate.release();
			await prompt;
		},
	};
}

function detached(session: OpenedSession): Promise<WireRecord> {
	return opener.frame(
		(record) =>
			record.type === "session_status" &&
			record.sessionId === session.sessionId &&
			(record.lastChange as { cause?: unknown } | undefined)?.cause === "detach",
	);
}

/**
 * The word's packing is the cross-thread contract (`epoch << 3 | retired << 2 | mask`); it is read here rather than
 * imported, so this file still loads on a base without the module and its product rows fail for their own reason.
 */
const wordState = (word: number) => ({ epoch: word >>> 3, retired: (word & 4) !== 0, mask: word & 3 });

/** Mechanism check (class K at main): the peer's current authority word on the host. */
function wordOf(peer: Peer): Int32Array {
	const authority = host.writer.delegations.recordOf(peer.connectionId)?.current?.authority;
	if (authority === undefined) throw new Error(`no authority word for ${peer.connectionId}`);
	return new Int32Array(authority);
}

describe("omo-relay-daemon#307: a revocation reaches a record already admitted to a blocked worker", () => {
	it("E8: a narrowing written after a pending hold refuses it in the worker", async () => {
		const session = await retained();
		const peer = await peerOn(session);
		expect(await peer.send(hold(session))).toMatchObject({ success: true });
		const blocked = await block(session);
		const [held, narrowed] = peer.sendTogether([
			hold(session, { id: "e8-B", relayExec: 2 }),
			{ type: "declare_delegation", principal: VIEWER, granted: GRANT, roles: [] },
		]);
		expect(await narrowed).toMatchObject({ success: true });
		expect(peer.pending("e8-B")).toBe(true);
		await blocked.release();
		expect(await held).toMatchObject({
			success: false,
			error: NOT_INTERACTIVE,
			authority: { exec: 2, incarnation: 1, epoch: 2, roles: [] },
		});
		const state = wordState(await awaitWord(wordOf(peer), 0, (value) => wordState(value).epoch === 2));
		expect(state).toMatchObject({ mask: 0, retired: false });
	}, 60_000);

	it("E9: a close after a pending hold refuses it in the worker; the input is never held", async () => {
		const session = await retained();
		const peer = await peerOn(session);
		expect(await peer.send(hold(session))).toMatchObject({ success: true });
		const blocked = await block(session);
		const [held, sentinel] = peer.sendTogether([
			hold(session, { id: "e9-B", inputId: "e9-B" }),
			{ type: "classify_record", record: { type: "prompt" } },
		]);
		held.catch(() => undefined);
		expect(await sentinel).toMatchObject({ success: true });
		expect(peer.pending("e9-B")).toBe(true);
		const record = host.writer.delegations.recordOf?.(peer.connectionId);
		const gone = detached(session);
		peer.socket.destroy();
		await gone;
		await blocked.release();
		expect(
			await opener.send({ type: "withdraw_held_input", sessionId: session.sessionId, inputId: "e9-B" }),
		).toMatchObject({ success: true, data: { withdrawn: false } });
		// Mechanism check (class K at main): the close stored the retired bit into the word the worker read.
		const authority = record?.current?.authority;
		expect(authority).toBeDefined();
		const word = new Int32Array(authority ?? new SharedArrayBuffer(8));
		expect(wordState(await awaitWord(word, 0, (value) => wordState(value).retired)).retired).toBe(true);
	}, 60_000);

	it("C5 (control): input held before the close stays held", async () => {
		const session = await retained();
		const peer = await peerOn(session);
		expect(await peer.send(hold(session, { inputId: "c5-B" }))).toMatchObject({ success: true });
		const gone = detached(session);
		peer.socket.destroy();
		await gone;
		expect(
			await opener.send({ type: "withdraw_held_input", sessionId: session.sessionId, inputId: "c5-B" }),
		).toMatchObject({ success: true, data: { withdrawn: true } });
	}, 60_000);
});

describe("omo-relay-daemon#307: a session worker never keeps the authority of the command that opened it", () => {
	it("R1: responses a worker forwards later carry only their own command's receipt, on every connection", async () => {
		// P opens the session itself, so its worker is created inside P's numbered command (exec 7).
		const p = await host.proven();
		expect(await declare(p, GRANT, VIEWER, { roles: BOTH })).toMatchObject({ success: true });
		const opened = await p.send({ type: "open_session", retain_on_disconnect: true, relayExec: 7 });
		expect(opened).toMatchObject({ success: true, authority: { exec: 7 } });
		const data = opened.data as { sessionId: string; state: { sessionId: string } };
		const session = { sessionId: data.sessionId, durableSessionId: data.state.sessionId };
		expect(await p.send({ type: "set_client_info", capabilities: ["interactive_user"] })).toMatchObject({
			success: true,
		});
		const q = await peerOn(session);
		for (const peer of [p, q]) {
			const unnumbered = [
				await peer.send(hold(session)),
				await peer.send({ type: "get_state", sessionId: session.sessionId }),
			];
			for (const answer of unnumbered) {
				expect(answer).toMatchObject({ success: true });
				expect(answer).not.toHaveProperty("authority");
			}
			expect(await peer.send(hold(session, { relayExec: 9 }))).toMatchObject({
				success: true,
				authority: { exec: 9, incarnation: 1, roles: ["interactive_user"] },
			});
		}
	}, 60_000);
});

describe("omo-relay-daemon#307: a declaration carries the incarnation it was made under (v5 §3.6)", () => {
	it("L2: a declaration delayed past detach_connection is refused alone; k+1 claims; a close leaves the worker", async () => {
		const session = await retained();
		const peer = await peerOn(session, []);
		// (a) the session-scoped declaration captures incarnation 1 and waits behind the blocked worker.
		let blocked = await block(session);
		const [late, detach] = peer.sendTogether([
			{ type: "set_client_info", sessionId: session.sessionId, capabilities: ["interactive_user"] },
			{ type: "detach_connection" },
		]);
		expect(await detach).toMatchObject({ success: true });
		await blocked.release();
		expect(await late).toMatchObject({ success: false, errorCode: "delegation_incarnation_stale" });
		expect(await peer.send(attach(session))).toMatchObject({ success: true });
		expect(await peer.send(hold(session, { relayExec: 1 }))).toMatchObject({
			success: false,
			error: NOT_INTERACTIVE,
			authority: { exec: 1, incarnation: 2 },
		});
		expect(await opener.send({ type: "get_state", sessionId: session.sessionId })).toMatchObject({ success: true });
		// (b) a declaration made on incarnation 2 claims for it.
		expect(
			await peer.send({ type: "set_client_info", sessionId: session.sessionId, capabilities: ["interactive_user"] }),
		).toMatchObject({ success: true });
		expect(await peer.send(hold(session, { relayExec: 2 }))).toMatchObject({
			success: true,
			authority: { exec: 2, incarnation: 2, roles: ["interactive_user"] },
		});
		// (c) a declaration still queued when the socket closes is answered stale, and the worker lives on.
		blocked = await block(session);
		peer
			.send({ type: "set_client_info", sessionId: session.sessionId, capabilities: ["interactive_user"] })
			.catch(() => undefined);
		const gone = detached(session);
		peer.socket.destroy();
		await gone;
		await blocked.release();
		expect(await opener.send({ type: "get_state", sessionId: session.sessionId })).toMatchObject({ success: true });
		const record = host.writer.delegations.recordOf(peer.connectionId);
		expect(record === undefined || record.closed).toBe(true);
	}, 90_000);

	it("L3: a worker that first sees the peer after its detach reads the narrowed incarnation 2", async () => {
		const first = await retained();
		const peer = await peerOn(first);
		expect(await declare(peer, GRANT, VIEWER, { roles: [] })).toMatchObject({ success: true });
		expect(await peer.send({ type: "detach_connection" })).toMatchObject({ success: true });
		const second = await retained();
		expect(await peer.send({ type: "set_client_info", capabilities: ["interactive_user"] })).toMatchObject({
			success: true,
		});
		expect(await peer.send(attach(second))).toMatchObject({ success: true });
		expect(await peer.send(hold(second, { relayExec: 3 }))).toMatchObject({
			success: false,
			error: NOT_INTERACTIVE,
			authority: { exec: 3, incarnation: 2, epoch: 1, roles: [] },
		});
	}, 60_000);
});
