/**
 * The delegated host fixture with a gated probe: every scripted model turn reads `probe.txt` once, so a turn that runs
 * on `full-access` returns PROBE_TEXT and a turn on `ask` raises "Permission required: read" first. Frames are read
 * through a `FrameLog`, which keeps only what arrived after it was created, so one peer can run several turns.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ANSWER_DEADLINE_MS, type DelegatedHost, declare, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { probeExtensionSource } from "./rpc-permission-mode-support.ts";
import type { WireRecord } from "./rpc-delegated-peer.ts";

export const PROBE_TEXT = "probe-content-6189-delegated";
export const ASKED = ["Permission required: read"];
export const DEVICE = { deviceId: "x6189-device", deviceName: "Remote" };
const GRANT = ["observe", "drive", "thread", "answer", "device_admin"];
const SCRIPTED_TURNS = 24;

/** The probe turns, plus `extra` extensions (an engine follow-up, a held tool) for the row under test. */
export async function permissionHost(
	extra: readonly ExtensionFactory[] = [],
	options: {
		readonly embedderPreset?: boolean;
		readonly hostArgs?: readonly string[];
		readonly workers?: boolean;
	} = {},
): Promise<DelegatedHost> {
	const host = await startHost({
		extensionFactories: extra,
		settingsDefaultPreset: options.embedderPreset !== true,
		...(options.hostArgs === undefined ? {} : { hostArgs: options.hostArgs }),
		...(options.workers ? { workers: true, workerExtensionSource: probeExtensionSource("probe-") } : {}),
	});
	await writeFile(join(host.cwd, "probe.txt"), PROBE_TEXT);
	host.faux.setResponses(probeTurns(SCRIPTED_TURNS));
	return host;
}

export function probeTurns(count: number) {
	const turns = [];
	for (let turn = 0; turn < count; turn++) {
		turns.push(
			fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" }, { id: `probe-${turn}` })], {
				stopReason: "toolUse",
			}),
		);
		turns.push(fauxAssistantMessage("done"));
	}
	return turns;
}

/** A connection of the remote device: delegated, allowed to drive the session and to answer its dialogs. */
export async function remotePeer(host: DelegatedHost): Promise<Peer> {
	const peer = await host.proven();
	const declared = await declare(peer, GRANT, DEVICE);
	if (declared.success !== true) throw new Error(`declare_delegation refused: ${JSON.stringify(declared)}`);
	return peer;
}

export async function open(
	peer: Peer,
	extra: WireRecord = {},
): Promise<{ sessionId: string; durableSessionId: string }> {
	const answer = await peer.send({ type: "open_session", ...extra });
	if (answer.success !== true) throw new Error(`open_session refused: ${JSON.stringify(answer)}`);
	const data = answer.data as { sessionId: string; state: { sessionId: string } };
	return { sessionId: data.sessionId, durableSessionId: data.state.sessionId };
}

/** Every frame `peer` receives from now on, with a bounded wait for the next one matching a predicate. */
export class FrameLog {
	readonly frames: WireRecord[] = [];
	private readonly watchers = new Set<(record: WireRecord) => void>();

	constructor(peer: Peer) {
		// Frames come from the peer's own reader: a second line reader attached mid-stream could start mid-line.
		peer.subscribe((record) => {
			this.frames.push(record);
			for (const watch of this.watchers) watch(record);
		});
	}

	next(predicate: (record: WireRecord) => boolean, from = 0): Promise<WireRecord> {
		const seen = this.frames.slice(from).find(predicate);
		if (seen) return Promise.resolve(seen);
		return new Promise<WireRecord>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.watchers.delete(watch);
				reject(new Error("no matching frame"));
			}, ANSWER_DEADLINE_MS);
			const watch = (record: WireRecord) => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				this.watchers.delete(watch);
				resolve(record);
			};
			this.watchers.add(watch);
		});
	}
}

export interface ProbeCall {
	readonly asked: string[];
	readonly ran: boolean;
}

/**
 * Answers every permission dialog `answerer` sees for `sessionId` with `answer` while it waits for the next `count`
 * probe calls to end on `watcher`; resolves with each call's dialogs and whether it ran, once the turn that made the
 * last call has ended (its `agent_end`), so the next record never meets a streaming turn and a row never leaves one
 * streaming into the host's dispose.
 */
export async function probeCalls(
	watcher: FrameLog,
	answerer: { readonly log: FrameLog; readonly peer: Peer },
	sessionId: string,
	options: { readonly count: number; readonly answer: "Deny" | "Allow once"; readonly start: () => Promise<unknown> },
): Promise<ProbeCall[]> {
	const from = watcher.frames.length;
	const asked: string[] = [];
	const answered = new Set<unknown>();
	const answering = answerer.log.next((record) => {
		if (record.sessionId !== sessionId || record.type !== "extension_ui_request" || record.method !== "select")
			return false;
		if (answered.has(record.id)) return false;
		answered.add(record.id);
		asked.push(String(record.title).split("\n")[0]);
		answerer.peer.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId, id: record.id, value: options.answer })}\n`,
		);
		return false;
	}, answerer.log.frames.length);
	answering.catch(() => {});
	await options.start();
	const calls: ProbeCall[] = [];
	let cursor = from;
	for (let index = 0; index < options.count; index++) {
		const end = await watcher.next(
			(record) =>
				record.type === "tool_execution_end" &&
				record.sessionId === sessionId &&
				String(record.toolCallId ?? "").startsWith("probe-"),
			cursor,
		);
		cursor = watcher.frames.indexOf(end) + 1;
		calls.push({ asked: asked.splice(0), ran: JSON.stringify(end).includes(PROBE_TEXT) });
	}
	await watcher.next((record) => record.type === "agent_end" && record.sessionId === sessionId, cursor);
	return calls;
}
