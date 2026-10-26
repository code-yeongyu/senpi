import { type AssistantMessageEvent, getAssistantCapture } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "../../../../ai/src/utils/event-stream.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createRpcSessionBinding } from "../../../src/modes/rpc/session-binding.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { structuredLaneEnabled } from "../../../src/modes/rpc/structured-session-records.ts";
import {
	allControls,
	CONTROL_TYPES,
	firstAssistantMessage,
	type Lane,
	messageLabels,
	type ScriptedSession,
	scriptedSession,
	textReply,
} from "../structured-lane-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const ASSISTANT_TURN = [
	"message_start",
	"message_update:thinking_start",
	"message_block_metadata",
	"message_update:thinking_delta",
	"message_update:thinking_end",
	"message_block_metadata",
	"message_block_state:insert",
	"message_block_state:end",
	"message_update:toolcall_start",
	"message_update:toolcall_delta",
	"message_tool_arguments_reset",
	"message_update:toolcall_end",
	"message_end",
];

const sessions: ScriptedSession[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const session of sessions.splice(0)) await session.close();
});

function leaked(records: readonly object[]): string[] {
	return records.flatMap((record) => {
		const text = JSON.stringify(record);
		const value = record as Lane;
		return [
			...CONTROL_TYPES.filter((type) => value.type === type || text.includes(`"type":"${type}"`)),
			...(value.assistantMessageEvent?.seed !== undefined ? ["seed"] : []),
			...(value.assistantMessageEvent?.offset !== undefined ? ["offset"] : []),
		];
	});
}

interface Run {
	readonly lane: Lane[][];
	readonly socket: string[];
	readonly stdout: string[];
	readonly extension: object[];
	readonly hasWriteStructured: boolean[];
}

async function runControls(flag: boolean): Promise<Run> {
	vi.unstubAllEnvs();
	if (flag) vi.stubEnv(FLAG, "1");
	expect(structuredLaneEnabled()).toBe(flag);
	const extension: object[] = [];
	// Holds the session's event queue at the first thinking_start until the agent has emitted message_end, so a
	// control that skipped the queue would overtake the queued events.
	const hold = Promise.withResolvers<void>();
	const listen = (pi: ExtensionAPI) => {
		pi.on("message_start", (event) => void extension.push(event));
		pi.on("message_update", async (event) => {
			extension.push(event);
			if (event.assistantMessageEvent.type === "thinking_start") await hold.promise;
		});
		pi.on("message_end", (event) => void extension.push(event));
		pi.on("turn_end", (event) => void extension.push(event));
	};
	const session = await scriptedSession([allControls, textReply("ok"), allControls, textReply("ok")], {
		extensionFactories: [listen],
	});
	sessions.push(session);
	const stopHold = session.harness.agent.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") hold.resolve();
	});
	const stdout: string[] = [];
	const stopStdout = session.harness.session.subscribe((event) => stdout.push(JSON.stringify(toJsonEvent(event))));
	const writer = new SessionEventWriter(() => {});
	const socket: string[] = [];
	writer.registerConnection("client", { writeRaw: (line) => socket.push(line), waitForBackpressure: async () => {} });
	writer.attachConnectionToSession("client", "session");
	const lane: Lane[][] = [];
	const hasWriteStructured: boolean[] = [];
	try {
		for (let bind = 0; bind < 2; bind++) {
			const records: Lane[] = [];
			lane.push(records);
			const stop = writer.structuredLanes.observe("session", (record) => records.push(record));
			const binding = await createRpcSessionBinding("session", session.entry, writer, () => {});
			try {
				await session.prompt(`go ${bind}`);
				await writer.flush();
			} finally {
				await binding.dispose();
				stop();
			}
			hasWriteStructured.push(records.length > 0);
		}
	} finally {
		hold.resolve();
		stopHold();
		stopStdout();
		writer.unregisterConnection("client");
	}
	return { lane, socket, stdout, extension, hasWriteStructured };
}

const updates = (lines: readonly string[]) =>
	lines
		.filter((line) => line.includes('"type":"message_update"'))
		.map((line) => line.replace(/faux:\d+:[a-z0-9]+/g, "faux").replace(/"(startedAt|endedAt)":\d+/g, '"$1":0'));

describe("T6 structured lane bridge", () => {
	it("T6 orders all three controls among ordinary records on the lane, on every bind, and never anywhere legacy", async () => {
		const run = await runControls(true);
		for (const records of run.lane) {
			const turn = firstAssistantMessage(records);
			expect(messageLabels(turn)).toEqual(ASSISTANT_TURN);
			expect(turn.at(-1)?.invalidatedBlocks).toBeUndefined();
			expect(turn.find((record) => record.type === "message_tool_arguments_reset")).toEqual({
				type: "message_tool_arguments_reset",
				contentIndex: 2,
				rawArgumentPrefix: '{"a":1}',
				parsedThrough: 7,
				sessionId: "session",
			});
			expect(turn.find((record) => record.type === "message_update")).toMatchObject({
				sessionId: "session",
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0, seed: { coveredCodeUnits: 0 } },
			});
			for (const key of ["messageId", "turnId", "runtimeItemKey"])
				expect(records.filter((record) => key in record)).toEqual([]);
		}
		expect(leaked(run.socket.map((line) => JSON.parse(line)))).toEqual([]);
		expect(leaked(run.stdout.map((line) => JSON.parse(line)))).toEqual([]);
		expect(leaked(run.extension)).toEqual([]);
		expect(run.extension.length).toBeGreaterThan(10);
	});

	it("keeps legacy socket and classic stdout bytes identical with the flag off, and opens no lane", async () => {
		const on = await runControls(true);
		const off = await runControls(false);
		expect(off.hasWriteStructured).toEqual([false, false]);
		expect(on.hasWriteStructured).toEqual([true, true]);
		expect(updates(on.socket).length).toBeGreaterThan(10);
		expect(updates(on.socket)).toEqual(updates(off.socket));
		expect(updates(on.stdout)).toEqual(updates(off.stdout));
	});

	it("measures the module-wide capture subscription on a stream no lane owns (LOW b)", async () => {
		const session = await scriptedSession([]);
		sessions.push(session);
		const captured = (): boolean => {
			const stream = new AssistantMessageEventStream({ captureBlocks: true });
			const event: AssistantMessageEvent = {
				type: "start",
				partial: {
					role: "assistant",
					api: "faux",
					provider: "faux",
					model: "unrelated",
					content: [],
					timestamp: 1,
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			};
			stream.push(event);
			return getAssistantCapture(event) !== undefined;
		};
		const before = captured();
		const stop = session.harness.session.subscribeStructured(() => {});
		const during = captured();
		stop();
		const after = captured();
		console.log(`LOW-b unrelated stream captured: before=${before} during=${during} after=${after}`);
		expect([before, during, after]).toEqual([false, true, false]);
	});
});
