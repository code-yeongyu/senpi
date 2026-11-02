import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, vi } from "vitest";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { type RpcSessionEntry, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { component, componentText } from "./4272-frozen-bytes-support.ts";
import { EVENT_SAFETY_MS } from "./4272-worker-acceptance-support.ts";

// senpi#5331 (RULING-120): one real flag-on host, a legacy opener and a `compact_events` peer on the same session, and
// three prompts whose middle assistant write is refused, so the live records cover a joined message, an entry join and
// a failed terminal.

export const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
export const LIVE_TYPES: readonly string[] = ["message_end", "entry_appended", "transcript_write_failed"];
export const STAMP_KEYS: readonly string[] = ["messageId", "terminalSequence", "owningMessageId"];

export type LiveRun = Awaited<ReturnType<typeof liveRun>>;

export async function liveRun(flag: "1" | "0") {
	vi.stubEnv(FLAG, flag);
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T00:00:00.000Z") });
	const host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const legacy = host.client("legacy");
	const routing = String(dataOf(await legacy.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	admissions.mockRestore();
	const session = entry?.runtime?.session ?? expect.unreachable("no in-process session");
	const compact = host.client("compact");
	host.writer.setConnectionCapabilities("compact", ["compact_events"]);
	host.writer.attachConnectionToSession("compact", routing);
	const prompt = async (message: string, answer: string): Promise<void> => {
		host.faux.setResponses([fauxAssistantMessage(answer, { timestamp: 1 })]);
		const idle = (record: WireRecord) => record.type === "agent_idle" && record.sessionId === routing;
		const seen = legacy.inbox.filter(idle).length;
		const done = legacy.waitFor((record) => idle(record) && legacy.inbox.filter(idle).length > seen, EVENT_SAFETY_MS);
		dataOf(await legacy.request({ type: "prompt", sessionId: routing, message }));
		await done;
		await host.writer.flush();
	};
	await prompt("first", "persisted answer");
	const append = session.sessionManager.appendOwnedMessage.bind(session.sessionManager);
	const refuse = vi.spyOn(session.sessionManager, "appendOwnedMessage").mockImplementation((message, options) => {
		if (message.role === "assistant") throw new Error("EACCES: injected transcript failure");
		return append(message, options);
	});
	await prompt("second", "refused answer");
	refuse.mockRestore();
	await prompt("third", "after the failure");
	return { host, legacy, compact, routing, lane: entry?.acceptance, prompt };
}

/** The exact lines `client` received for this session's records `keep` selects (the three live types by default). */
export function liveLines(
	client: RawClient,
	sessionId: string,
	keep: (record: WireRecord) => boolean = (record) => LIVE_TYPES.includes(String(record.type)),
): { line: string; record: WireRecord }[] {
	return client.received
		.join("")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => ({ line, record: JSON.parse(line) as WireRecord }))
		.filter(({ record }) => keep(record) && record.sessionId === sessionId);
}

export const liveRecords = (client: RawClient, sessionId: string): WireRecord[] =>
	liveLines(client, sessionId).map(({ record }) => record);

/** The live `message_end` of the assistant message whose text contains `text`. */
export function assistantEnd(records: readonly WireRecord[], text: string): WireRecord {
	const found = records.find((record) => {
		const message = record.message as { role?: unknown; content?: unknown } | undefined;
		return (
			record.type === "message_end" &&
			message?.role === "assistant" &&
			JSON.stringify(message.content).includes(text)
		);
	});
	return found ?? expect.unreachable(`no assistant message_end for ${text}`);
}

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

/** A peer that reconnects after `dropped`: a new transport with `compact_events`, attached to the same session. */
export async function reconnect(
	run: Pick<LiveRun, "host" | "routing">,
	dropped: string,
	name: string,
): Promise<RawClient> {
	await run.host.drop(dropped);
	const again = run.host.client(name);
	run.host.writer.setConnectionCapabilities(name, ["compact_events"]);
	run.host.writer.attachConnectionToSession(name, run.routing);
	return again;
}

/** The rows of `kinds` (settled and identity by default) in a recovery cut `peer` freezes now, keyed `<kind>/<member>`. */
export async function recoveredRows(
	run: Pick<LiveRun, "host" | "routing" | "lane">,
	peer: string,
	kinds: readonly string[] = ["settled", "identity"],
): Promise<Map<string, Record<string, unknown>>> {
	const { host, routing } = run;
	const lane = run.lane ?? expect.unreachable("no acceptance lane with the flag on");
	const socketEpoch = host.writer.socketEpochOf(peer) ?? expect.unreachable();
	const route = {
		socketEpoch,
		admissionId: `recover-${peer}`,
		routeKind: "ordinary" as const,
		peer,
		sessionId: routing,
	};
	await lane.idle();
	const token = unwrap(host.writer.recoveryCheckpoints.freeze(route, lane)).token;
	const caller = { socketEpoch, sessionId: routing };
	try {
		const manifest = unwrap(await host.writer.recoveryCheckpoints.catalog(token, caller));
		const root = unwrap(await host.writer.recoveryCheckpoints.readCatalog(token, caller, manifest.catalogRoot));
		if (root.kind !== "node") throw new Error("the catalog root is a node");
		const rows = new Map<string, Record<string, unknown>>();
		for (const [index, entry] of root.entries.entries()) {
			if (!kinds.includes(entry.kind)) continue;
			const ref = `${manifest.catalogRoot}:${String(index).padStart(3, "0")}`;
			const text = await componentText(
				component(unwrap(await host.writer.recoveryCheckpoints.readCatalog(token, caller, ref))),
			);
			if (text !== "") rows.set(`${entry.kind}/${entry.id}`, JSON.parse(text) as Record<string, unknown>);
		}
		return rows;
	} finally {
		host.writer.recoveryCheckpoints.release(token);
	}
}

/** The `{messageId, entryId}` of every `identity/join-<n>` row. */
export const joinsOf = (rows: ReadonlyMap<string, Record<string, unknown>>) =>
	[...rows].filter(([key]) => key.startsWith("identity/join-")).map(([, value]) => value);
