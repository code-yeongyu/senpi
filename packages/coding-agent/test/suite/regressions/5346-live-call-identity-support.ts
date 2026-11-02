import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, vi } from "vitest";
import { type RpcSessionEntry, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { EVENT_SAFETY_MS } from "./4272-worker-acceptance-support.ts";
import { FLAG, liveLines, reconnect, recoveredRows } from "./5331-live-identity-support.ts";

// senpi#5346 (RULING-123): one real host, a legacy opener and a `compact_events` peer on one session. Prompt A reads a
// file as toolCallId `reused` and its tool result write is refused, so the call keeps a settled row. A PreToolUse hook
// then runs for a call the session never announced (`ghost`). Prompt B runs a registered `probe` tool, which reports one update, under the SAME toolCallId and holds
// its PreToolUse hook while the compact peer reconnects and freezes a recovery cut, so that call is a `calls` row.

export const REUSED = "reused";
export const GHOST = "ghost";
export const CALL_STAMPS: readonly string[] = ["runtimeItemKey", "callUnknown"];
const EXECUTION = ["tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_hook_status"];

type StreamEvent = {
	type?: unknown;
	contentIndex?: number;
	partial?: { content?: { id?: unknown; name?: unknown }[] };
};
const streamEvent = (record: WireRecord) => record.assistantMessageEvent as StreamEvent | undefined;

export function isCallRecord(record: WireRecord): boolean {
	const kind = streamEvent(record)?.type;
	if (EXECUTION.includes(String(record.type))) return true;
	return record.type === "message_update" && typeof kind === "string" && kind.startsWith("toolcall_");
}

/** Which call a record is about: `ghost`, or the tool it runs (`read` for prompt A, `probe` for prompt B). */
export function callName(record: WireRecord): string {
	const event = streamEvent(record);
	const block = event?.partial?.content?.[event.contentIndex ?? -1];
	return (record.toolCallId ?? block?.id) === GHOST ? GHOST : String(record.toolName ?? block?.name);
}

export const callLines = (client: RawClient, sessionId: string) => liveLines(client, sessionId, isCallRecord);
export const callRecords = (client: RawClient, sessionId: string): WireRecord[] =>
	callLines(client, sessionId).map(({ record }) => record);

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]): AssistantMessage =>
	fauxAssistantMessage(fauxToolCall(name, args, { id: REUSED }), { stopReason: "toolUse", timestamp: 1 });

export type CallRun = Awaited<ReturnType<typeof callRun>>;

export async function callRun(flag: "1" | "0") {
	vi.stubEnv(FLAG, flag);
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T00:00:00.000Z") });
	const host = await statusHost();
	await writeFile(join(host.cwd, "note.txt"), "note body\n");
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
	const run = { host, legacy, compact, routing, lane: entry?.acceptance };
	const api = host.extensionApis.get(session.sessionManager.getSessionId()) ?? expect.unreachable("no extension api");
	api.registerTool({
		name: "probe",
		label: "Probe",
		description: "Report one progress update, then finish",
		parameters: Type.Object({ step: Type.String() }),
		execute: async (_id, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "halfway" }], details: {} });
			return { content: [{ type: "text", text: "probed" }], details: {} };
		},
	});
	let hold: { readonly reached: () => void; readonly released: Promise<void> } | undefined;
	api.on("tool_call", async (_event, ctx) => {
		ctx.updateToolHookStatus?.("checking");
		const held = hold;
		hold = undefined;
		held?.reached();
		await held?.released;
		return undefined;
	});
	const prompt = async (message: string, responses: AssistantMessage[], during?: () => Promise<void>) => {
		host.faux.setResponses(responses);
		const idle = (record: WireRecord) => record.type === "agent_idle" && record.sessionId === routing;
		const seen = legacy.inbox.filter(idle).length;
		const done = legacy.waitFor((record) => idle(record) && legacy.inbox.filter(idle).length > seen, EVENT_SAFETY_MS);
		const reached = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		if (during) hold = { reached: reached.resolve, released: released.promise };
		dataOf(await legacy.request({ type: "prompt", sessionId: routing, message }));
		if (during) {
			await Promise.race([reached.promise, done.then(() => expect.unreachable("the hook was never reached"))]);
			await host.writer.flush();
			await during();
			released.resolve();
		}
		await done;
		await host.writer.flush();
	};
	const append = session.sessionManager.appendOwnedMessage.bind(session.sessionManager);
	const refuse = vi.spyOn(session.sessionManager, "appendOwnedMessage").mockImplementation((message, options) => {
		if (message.role === "toolResult") throw new Error("EACCES: injected transcript failure");
		return append(message, options);
	});
	await prompt("first", [call("read", { path: "note.txt" }), fauxAssistantMessage("read one", { timestamp: 1 })]);
	refuse.mockRestore();
	await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: GHOST, input: {} });
	await host.writer.flush();
	let again: RawClient | undefined;
	let cut = new Map<string, Record<string, unknown>>();
	await prompt(
		"second",
		[call("probe", { step: "two" }), fauxAssistantMessage("ran two", { timestamp: 1 })],
		async () => {
			again = await reconnect(run, "compact", "compact-again");
			if (run.lane) cut = await recoveredRows(run, "compact-again", ["settled", "calls"]);
		},
	);
	return { ...run, again: again ?? expect.unreachable("no reconnect"), cut };
}

/** Every call record the compact side received: the first peer's, then the reconnected peer's. */
export const compactCalls = (run: CallRun): WireRecord[] => [
	...callRecords(run.compact, run.routing),
	...callRecords(run.again, run.routing),
];

export const rowsOf = (run: CallRun, kind: string): Record<string, unknown>[] =>
	[...run.cut].filter(([key]) => key.startsWith(`${kind}/`)).map(([, row]) => row);
