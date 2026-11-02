import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { callRecords } from "./5346-live-call-identity-support.ts";
import { type StampHost, stampHost, stampsOf, streamEventOf, toolUse } from "./5346-stamp-host-support.ts";

// senpi#5346 (RULING-123, C3.4): two calls reusing one toolCallId inside ONE assistant message. A `toolcall_*` update
// names its block by contentIndex, so it is keyed exactly. An execution or hook record names only the toolCallId, so no
// order may decide which of the two it belongs to: it says `callUnknown`, never a confident key that can be wrong.

let run: StampHost | undefined;
afterEach(async () => {
	await run?.host[Symbol.asyncDispose]();
	run = undefined;
	vi.unstubAllEnvs();
});

const DUP = "dup";

it("RULING-123 C3.4 #5346 same-message reuse of one toolCallId: toolcall updates are keyed by block, execution records say callUnknown", async () => {
	run = await stampHost();
	const compact = run.host.client("compact");
	run.host.writer.setConnectionCapabilities("compact", ["compact_events"]);
	run.host.writer.attachConnectionToSession("compact", run.routing);
	await run.prompt([
		toolUse(
			fauxToolCall("read", { path: "first.txt" }, { id: DUP }),
			fauxToolCall("read", { path: "second.txt" }, { id: DUP }),
		),
		fauxAssistantMessage("done", { timestamp: 1 }),
	]);
	await run.host.writer.flush();
	const records = callRecords(compact, run.routing);
	for (const record of records) expect(stampsOf(record), String(record.type)).toHaveLength(1);
	const keysByBlock = new Map<unknown, Set<unknown>>();
	for (const record of records.filter((item) => item.type === "message_update")) {
		const block = streamEventOf(record).contentIndex;
		keysByBlock.set(block, (keysByBlock.get(block) ?? new Set()).add(record.runtimeItemKey));
	}
	expect([...keysByBlock.keys()]).toEqual([0, 1]);
	const keys = [...keysByBlock.values()].map((set) => [...set]);
	for (const [key, ...others] of keys) {
		expect(typeof key, "a toolcall update names its block's call").toBe("string");
		expect(others, "one key per block").toEqual([]);
	}
	expect(keys[0]?.[0]).not.toBe(keys[1]?.[0]);
	const executed = records.filter((record) => record.type !== "message_update");
	const kinds = executed.map((record) => record.type);
	expect(kinds.filter((kind) => kind === "tool_execution_start")).toHaveLength(2);
	expect(kinds.filter((kind) => kind === "tool_execution_end")).toHaveLength(2);
	for (const record of executed) {
		expect(record, String(record.type)).toMatchObject({ toolCallId: DUP, callUnknown: true });
		expect(record).not.toHaveProperty("runtimeItemKey");
	}
}, 600_000);
