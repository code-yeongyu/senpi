/** Shared steps of the retained-session restart suites (senpi#6190): real socket hosts on one socket and agent dir. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect } from "vitest";
import { MOCK_MODEL, MOCK_PROVIDER } from "./rpc-hermetic.ts";
import type { JsonlPeer } from "./rpc-jsonl-peer.ts";
import {
	connectPeer,
	messageText,
	openedSessionId,
	type scratch,
	spawnRpc,
	waitForStderr,
} from "./rpc-socket-host-support.ts";

export type Scratch = ReturnType<typeof scratch>;

export interface OpenedSession {
	readonly handle: string;
	readonly durableId: string;
	readonly sessionFile: string;
	readonly prompt: string;
}

export interface ListedRow {
	readonly sessionId: string;
	readonly durableSessionId?: string;
	readonly retain_on_disconnect?: boolean;
}

export const RECORD_WAIT_MS = 30_000;
export const HOLD_MARKER = "hold-this-turn-open";

export async function startHost(qa: Scratch): Promise<ChildProcessWithoutNullStreams> {
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
export async function openWithTurn(peer: JsonlPeer, cwd: string, label: string): Promise<OpenedSession> {
	const opened = await peer.request({ id: `open-${label}`, type: "open_session", cwd, retain_on_disconnect: true });
	const handle = openedSessionId(opened);
	const state = (opened.data as { state: { sessionId: string; sessionFile: string } }).state;
	const prompt = `first-turn-${label}`;
	await runTurn(peer, handle, prompt);
	return { handle, durableId: state.sessionId, sessionFile: state.sessionFile, prompt };
}

/** One prompt on the session, resolved once its turn has settled. */
export async function runTurn(peer: JsonlPeer, handle: string, prompt: string): Promise<void> {
	const seen = peer.messages.length;
	const settled = peer.waitFor(
		(value) => value.type === "agent_settled" && value.sessionId === handle && peer.messages.indexOf(value) >= seen,
		RECORD_WAIT_MS,
	);
	await peer.request({ id: `turn-${prompt}`, type: "prompt", sessionId: handle, message: prompt });
	await settled;
}

export async function startHeldTurn(peer: JsonlPeer, session: OpenedSession): Promise<void> {
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

export async function stopHost(host: ChildProcessWithoutNullStreams, signal: "SIGKILL" | "SIGTERM"): Promise<void> {
	const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
	host.kill(signal);
	await exited;
}

/**
 * Waits until the restarted host lists every durable id. Its reopen runs in the background after it binds, so a
 * session missing from the first listing is awaited through its `session_opened` broadcast, subscribed beforehand.
 */
export async function waitListed(peer: JsonlPeer, durableIds: readonly string[]): Promise<readonly ListedRow[]> {
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

export async function attachAndPrompt(peer: JsonlPeer, session: OpenedSession, row: ListedRow): Promise<void> {
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

export async function expectRestored(qa: Scratch, sessions: readonly OpenedSession[]): Promise<void> {
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
