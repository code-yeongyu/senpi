import { afterEach, expect, it, vi } from "vitest";
import * as jsonl from "../../../src/modes/rpc/jsonl.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { FLAG } from "./4272-construction-host-support.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";

// Part of #4272 (S13, RULING-81 X06 = C): the legacy line of a record is built only when a legacy destination needs it.
// An oversized record whose only audience selected compact events is staged from a bounded piece stream, never as one
// encoded legacy line (0 encodings); with a legacy peer beside it the one legacy line serves both (exactly 1).

vi.mock("../../../src/modes/rpc/jsonl.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/modes/rpc/jsonl.ts")>();
	return { ...original, serializeJsonLine: vi.fn(original.serializeJsonLine) };
});

afterEach(() => {
	vi.unstubAllEnvs();
});

const big = (callId: string) => ({
	type: "tool_execution_end",
	toolCallId: callId,
	result: { content: [{ type: "text", text: "e".repeat(300_000) }] },
});
/** Legacy encodings of the whole record `callId` names: serializeJsonLine calls on it (an envelope is not one). */
const encodings = (callId: string): number =>
	vi
		.mocked(jsonl.serializeJsonLine)
		.mock.calls.filter(([value]) => (value as { toolCallId?: unknown }).toolCallId === callId).length;

it("RULING-81 X06 a compact-only audience costs 0 legacy encodings of an oversized record, a mixed audience exactly 1", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await statusHost();
	try {
		const opener = host.client("opener");
		const routing = String(dataOf(await opener.request({ type: "open_session", cwd: host.cwd })).sessionId);
		host.writer.detachConnectionFromSession("opener", routing);
		const compact = host.client("compact");
		host.writer.setConnectionCapabilities("compact", ["compact_events"]);
		host.writer.attachConnectionToSession("compact", routing);
		host.writer.enqueue(routing, big("c-only"));
		await host.writer.flush();
		expect(compact.inbox.some((record) => record.eventLease !== undefined)).toBe(true);
		expect(encodings("c-only"), "compact-only: no legacy line").toBe(0);
		const streamed = compact.inbox.find((record) => record.eventLease !== undefined)?.eventLease as
			| { length: number; digest: string }
			| undefined;
		const exact = Buffer.from(JSON.stringify({ ...big("c-only"), sessionId: routing }), "utf16le");
		expect(streamed, "the streamed content is the record's exact JSON text").toMatchObject({
			length: exact.length,
			digest: specDigest("leaf", exact),
		});
		const legacy = host.client("legacy");
		host.writer.attachConnectionToSession("legacy", routing);
		host.writer.enqueue(routing, big("c-mixed"));
		await host.writer.flush();
		expect(legacy.inbox.find((record) => record.toolCallId === "c-mixed")).toEqual({
			...big("c-mixed"),
			sessionId: routing,
		});
		expect(compact.inbox.filter((record) => record.eventLease !== undefined)).toHaveLength(2);
		expect(encodings("c-mixed"), "mixed: one legacy line serves both").toBe(1);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);
