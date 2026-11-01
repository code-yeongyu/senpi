import { type AssistantMessage, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { EVENT_SAFETY_MS } from "./4272-worker-acceptance-support.ts";
import { FLAG } from "./5331-live-identity-support.ts";
import { CALL_STAMPS } from "./5346-live-call-identity-support.ts";

// senpi#5346 review follow-ups: one flag-on host whose legacy opener drives prompts, and compact peers whose received
// lines a test reads directly.

export type StampHost = Awaited<ReturnType<typeof stampHost>>;

export async function stampHost(tokenSize?: { readonly min: number; readonly max: number }) {
	vi.stubEnv(FLAG, "1");
	const host = await statusHost(tokenSize ? { tokenSize } : {});
	const legacy = host.client("legacy");
	const routing = String(dataOf(await legacy.request({ type: "open_session", cwd: host.cwd })).sessionId);
	/** One prompt to its `agent_idle` on the legacy opener; no other peer is flushed. */
	const prompt = async (responses: AssistantMessage[]): Promise<void> => {
		host.faux.setResponses(responses);
		const idle = (record: WireRecord) => record.type === "agent_idle" && record.sessionId === routing;
		const seen = legacy.inbox.filter(idle).length;
		const done = legacy.waitFor((record) => idle(record) && legacy.inbox.filter(idle).length > seen, EVENT_SAFETY_MS);
		dataOf(await legacy.request({ type: "prompt", sessionId: routing, message: "go" }));
		await done;
	};
	return { host, routing, prompt };
}

/** A `compact_events` peer on the session whose transport takes one write, then none until `open()`: a stalled reader. */
export function stalledCompactPeer(run: Pick<StampHost, "host" | "routing">, name: string) {
	const writes: string[] = [];
	const gate = Promise.withResolvers<void>();
	run.host.writer.registerConnection(name, {
		writeRaw: (line) => {
			writes.push(line);
		},
		waitForBackpressure: () => gate.promise,
	});
	run.host.writer.setConnectionCapabilities(name, ["compact_events"]);
	run.host.writer.attachConnectionToSession(name, run.routing);
	return { writes, open: () => gate.resolve() };
}

export const recordsOf = (writes: readonly string[], sessionId: string): WireRecord[] =>
	writes
		.join("")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as WireRecord)
		.filter((record) => record.sessionId === sessionId);

export const toolUse = (...calls: ToolCall[]): AssistantMessage =>
	fauxAssistantMessage(calls, { stopReason: "toolUse", timestamp: 1 });

export const streamEventOf = (record: WireRecord) =>
	(record.assistantMessageEvent ?? {}) as { type?: unknown; contentIndex?: unknown; delta?: unknown };

/** The call stamps a record carries: RULING-123 requires exactly one on every compact live call record. */
export const stampsOf = (record: WireRecord): string[] => CALL_STAMPS.filter((key) => key in record);
