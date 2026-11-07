/**
 * senpi#6190: retained sessions survive their socket host. Whether the host is killed or stopped cleanly, and
 * whether the session was idle or mid-turn, the next host on the same socket and agent dir lists it again with
 * its durable id and transcript and a viewer can attach and prompt - the remote equivalent of a TUI resuming its
 * session file. A clean stop parks a retained session (`session_parked`, never `session_closed`), and a turn the
 * stop cuts short ends as a host shutdown, never as a user abort.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import type { JsonlPeer, RecordValue } from "./helpers/rpc-jsonl-peer.ts";
import {
	connectPeer,
	messageText,
	openedSessionId,
	scratch,
	spawnRpc,
	waitForStderr,
} from "./helpers/rpc-socket-host-support.ts";

type Scratch = ReturnType<typeof scratch>;

interface OpenedSession {
	readonly handle: string;
	readonly durableId: string;
	readonly sessionFile: string;
	readonly prompt: string;
}

interface ListedRow {
	readonly sessionId: string;
	readonly durableSessionId?: string;
	readonly retain_on_disconnect?: boolean;
}

const RECORD_WAIT_MS = 30_000;
const HOLD_MARKER = "hold-this-turn-open";

async function startHost(qa: Scratch): Promise<ChildProcessWithoutNullStreams> {
	const args = [
		"--mode",
		"rpc",
		"--listen",
		`unix://${qa.socketPath}`,
		"--provider",
		MOCK_PROVIDER,
		"--model",
		MOCK_MODEL,
	];
	const host = spawnRpc(args, qa);
	await waitForStderr(host, `senpi rpc listening on unix://${qa.socketPath}`);
	return host;
}

/** A retained session with one completed turn, so its transcript exists on disk. */
async function openWithTurn(peer: JsonlPeer, cwd: string, label: string): Promise<OpenedSession> {
	const opened = await peer.request({ id: `open-${label}`, type: "open_session", cwd, retain_on_disconnect: true });
	const handle = openedSessionId(opened);
	const state = (opened.data as { state: { sessionId: string; sessionFile: string } }).state;
	const prompt = `first-turn-${label}`;
	const seen = peer.messages.length;
	const settled = peer.waitFor(
		(value) => value.type === "agent_settled" && value.sessionId === handle && peer.messages.indexOf(value) >= seen,
		RECORD_WAIT_MS,
	);
	await peer.request({ id: `turn-${label}`, type: "prompt", sessionId: handle, message: prompt });
	await settled;
	return { handle, durableId: state.sessionId, sessionFile: state.sessionFile, prompt };
}

async function startHeldTurn(peer: JsonlPeer, session: OpenedSession): Promise<void> {
	const seen = peer.messages.length;
	const started = peer.waitFor(
		(value) =>
			value.type === "agent_start" && value.sessionId === session.handle && peer.messages.indexOf(value) >= seen,
		RECORD_WAIT_MS,
	);
	await peer.request({
		id: `held-${session.handle}`,
		type: "prompt",
		sessionId: session.handle,
		message: HOLD_MARKER,
	});
	await started;
}

async function stopHost(host: ChildProcessWithoutNullStreams, signal: "SIGKILL" | "SIGTERM"): Promise<void> {
	const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
	host.kill(signal);
	await exited;
}

/**
 * Waits until the restarted host lists every durable id. Its reopen runs in the background after it binds, so a
 * session missing from the first listing is awaited through its `session_opened` broadcast, subscribed beforehand.
 */
async function waitListed(peer: JsonlPeer, durableIds: readonly string[]): Promise<readonly ListedRow[]> {
	const list = async (id: string): Promise<readonly ListedRow[]> =>
		((await peer.request({ id, type: "list_sessions", include_workers: true })).data as { sessions: ListedRow[] })
			.sessions;
	const announced = durableIds.map((durableId) => {
		const opened = peer.waitFor(
			(value) => value.type === "session_opened" && value.durableSessionId === durableId,
			RECORD_WAIT_MS,
		);
		// Only the waits for sessions missing from the first listing are awaited; the rest must not reject unhandled.
		opened.catch(() => {});
		return opened;
	});
	await peer.request({ id: "subscribe", type: "subscribe_sessions", sessions: "all", include_workers: true });
	const first = (await list("list-first")).map((row) => row.durableSessionId);
	await Promise.all(durableIds.map((durableId, index) => (first.includes(durableId) ? undefined : announced[index])));
	return list("list-restored");
}

async function attachAndPrompt(peer: JsonlPeer, session: OpenedSession, row: ListedRow): Promise<void> {
	const attached = await peer.request({
		id: `attach-${session.durableId}`,
		type: "open_session",
		sessionPath: session.sessionFile,
		retain_on_disconnect: true,
	});
	expect(attached.success).toBe(true);
	expect(openedSessionId(attached)).toBe(row.sessionId);
	const transcript = await peer.request({
		id: `messages-${row.sessionId}`,
		type: "get_messages",
		sessionId: row.sessionId,
	});
	expect(((transcript.data as { messages?: unknown[] }).messages ?? []).map(messageText)).toContain(session.prompt);
	const seen = peer.messages.length;
	const settled = peer.waitFor(
		(value) =>
			value.type === "agent_settled" && value.sessionId === row.sessionId && peer.messages.indexOf(value) >= seen,
		RECORD_WAIT_MS,
	);
	const prompted = await peer.request({
		id: `again-${row.sessionId}`,
		type: "prompt",
		sessionId: row.sessionId,
		message: "after-restart",
	});
	expect(prompted.success).toBe(true);
	await settled;
}

async function expectRestored(qa: Scratch, sessions: readonly OpenedSession[]): Promise<void> {
	await startHost(qa);
	const viewer = await connectPeer(qa.socketPath);
	try {
		const rows = await waitListed(
			viewer.peer,
			sessions.map((session) => session.durableId),
		);
		for (const session of sessions) {
			const row = rows.find((candidate) => candidate.durableSessionId === session.durableId);
			expect(row, `durable ${session.durableId} is not listed after the restart`).toBeDefined();
			expect(row?.retain_on_disconnect).toBe(true);
			if (row !== undefined) await attachAndPrompt(viewer.peer, session, row);
		}
	} finally {
		viewer.socket.destroy();
	}
}

describe.skipIf(process.platform === "win32")("retained sessions across a socket host restart (senpi#6190)", () => {
	it("restores an idle and a mid-turn retained session after the host is killed", async () => {
		const qa = scratch("kill");
		const fake = await startFakeModelServer({ holdOnLastMessage: HOLD_MARKER });
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = await startHost(qa);
		const opener = await connectPeer(qa.socketPath);
		try {
			const idle = await openWithTurn(opener.peer, qa.cwd, "idle");
			const busy = await openWithTurn(opener.peer, qa.cwd, "busy");
			await startHeldTurn(opener.peer, busy);
			await stopHost(host, "SIGKILL");
			await expectRestored(qa, [idle, busy]);
		} finally {
			opener.socket.destroy();
			await fake.close();
		}
	}, 240_000);

	it("parks retained sessions on a clean stop, ends the cut turn as a host shutdown, and restores both", async () => {
		const qa = scratch("stop");
		const fake = await startFakeModelServer({ holdOnLastMessage: HOLD_MARKER });
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = await startHost(qa);
		const opener = await connectPeer(qa.socketPath);
		try {
			const idle = await openWithTurn(opener.peer, qa.cwd, "idle");
			const busy = await openWithTurn(opener.peer, qa.cwd, "busy");
			await startHeldTurn(opener.peer, busy);
			const seen = opener.peer.messages.length;
			const fresh = (value: RecordValue) => opener.peer.messages.indexOf(value) >= seen;
			const cutTurn = opener.peer.waitFor(
				(value) => value.type === "agent_end" && value.sessionId === busy.handle && fresh(value),
				RECORD_WAIT_MS,
			);
			const parked = [idle, busy].map((session) =>
				opener.peer.waitFor(
					(value) => value.type === "session_parked" && value.sessionId === session.handle,
					RECORD_WAIT_MS,
				),
			);
			await stopHost(host, "SIGTERM");

			expect(await cutTurn).toMatchObject({
				aborted: true,
				abortSource: "system",
				abortCause: { kind: "host_shutdown" },
			});
			for (const record of await Promise.all(parked)) expect(record).toMatchObject({ reason: "host_shutdown" });
			const closed = opener.peer.messages.filter(
				(value) =>
					value.type === "session_closed" && (value.sessionId === idle.handle || value.sessionId === busy.handle),
			);
			expect(closed).toEqual([]);
			await expectRestored(qa, [idle, busy]);
		} finally {
			opener.socket.destroy();
			await fake.close();
		}
	}, 240_000);
});
