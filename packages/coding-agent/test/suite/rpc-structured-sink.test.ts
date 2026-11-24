import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import * as connectionHandler from "../../src/modes/rpc/connection-handler.ts";
import * as eventBuffer from "../../src/modes/rpc/event-output-buffer.ts";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../../src/modes/rpc/custom-capability.ts";
import { omitInlineMedia } from "../../src/modes/rpc/media-placeholders.ts";
import { createRpcSessionBinding } from "../../src/modes/rpc/session-binding.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import type { RpcSessionEntry } from "../../src/modes/rpc/session-registry.ts";
import { createHarness } from "./harness.ts";
import { expectSameBytesExceptDeliveryStamp } from "../helpers/rpc-delivery-stamp.ts";

// Part of #4272, T6/X07: the binding must reach the writer before JSON amplification.
it("delivers faux streaming records by reference before the event output buffer", async () => {
	const scope = new ProviderScope();
	const harness = await runWithProviderScope(scope, () => createHarness());
	// Faux's 3-5-token chunk range becomes exactly 16 characters, without a timing dependency.
	const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("This fixture does not replace sessions");
		},
	);
	const entry: RpcSessionEntry = {
		scope,
		runtime,
		state: "open",
		kind: "interactive",
		context: {},
		profile: { cwd: harness.tempDir },
		cwd: harness.tempDir,
		attachments: 1,
		lastCommandAt: 0,
		lifecycleMutex: Promise.resolve(),
	};
	let current: AgentSessionEvent | undefined;
	const originals: boolean[] = [];
	const expected: string[] = [];
	const actual: string[] = [];
	const stringify = JSON.stringify;
	let inWriter = false;
	let sessionBytes = 0;
	let workerSizingBytes = 0;
	let updates = 0;
	const serialize = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
		const line = stringify(value, replacer, space);
		if (!inWriter && value?.type === "message_update" && value.sessionId === "session")
			sessionBytes += Buffer.byteLength(line);
		return line;
	});
	const stop = harness.session.subscribe((event) => {
		current = event;
	});
	class ObservingWriter extends SessionEventWriter {
		override enqueue(sessionId: string, record: object): boolean {
			if ("type" in record && record.type === "message_update") {
				if (
					"assistantMessageEvent" in record &&
					typeof record.assistantMessageEvent === "object" &&
					record.assistantMessageEvent !== null &&
					"type" in record.assistantMessageEvent &&
					record.assistantMessageEvent.type === "text_delta"
				)
					updates++;
				originals.push(
					current?.type === "message_update" &&
						"message" in record &&
						record.message === current.message &&
						"assistantMessageEvent" in record &&
						record.assistantMessageEvent === current.assistantMessageEvent,
				);
				workerSizingBytes += Buffer.byteLength(stringify(record));
			}
			// Reference bytes: the pre-S01 binding normalized a tagged record before enqueue.
			const normalized: object = JSON.parse(stringify(record));
			expected.push(`${stringify({ ...normalized, sessionId })}\n`);
			inWriter = true;
			try {
				return super.enqueue(sessionId, record);
			} finally {
				inWriter = false;
			}
		}
	}
	const writer = new ObservingWriter(() => {});
	writer.registerConnection("client", {
		writeRaw: (line) => actual.push(line),
		waitForBackpressure: async () => {},
	});
	writer.attachConnectionToSession("client", "session");
	const buffered = vi.spyOn(eventBuffer, "createRpcEventOutputBuffer");
	const handlers = vi.spyOn(connectionHandler, "createRpcConnectionHandler");
	const binding = await createRpcSessionBinding("session", entry, writer, () => {});
	try {
		harness.setResponses([fauxAssistantMessage("x".repeat(16 * 1024), { timestamp: 1 })]);
		await runWithProviderScope(scope, () => harness.session.prompt("stream"));
		await writer.flush();
		console.log(`X07 ${JSON.stringify({ updates, sessionBytes, workerSizingBytes })}`);
		expect(originals.length).toBeGreaterThan(100);
		expect(updates).toBe(1024);
		expect(originals.every(Boolean), "writer must receive the subscription's message and event objects").toBe(true);
		expect(buffered, "shared delivery must not construct the event output buffer").not.toHaveBeenCalled();
		expect(sessionBytes, "SESSION serialized bytes before writer").toBe(0);
		expectSameBytesExceptDeliveryStamp(actual, expected);
		const sink = handlers.mock.calls[0]?.[1];
		expect(sink?.writeRecord).toBeTypeOf("function");
		const parse = vi.spyOn(JSON, "parse");
		try {
			expect(() => sink?.writeRaw('{"type":"probe"}\n'), "writeRaw is unreachable beside writeRecord").toThrowError(
				/writeRecord/,
			);
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	} finally {
		handlers.mockRestore();
		buffered.mockRestore();
		serialize.mockRestore();
		random.mockRestore();
		stop();
		await binding.dispose();
		writer.unregisterConnection("client");
		runtime.releaseSessionHold();
		harness.cleanup();
		await scope.close();
	}
}, 30_000);

// Part of #4272: retained state is a function of accepted bytes, never a live provider object.
it.each([false, true])("freezes replay, placeholders and resync after provider mutation (eager=%s)", async (eager) => {
	const writer = new SessionEventWriter(() => {});
	const live: string[] = [];
	const replay: string[] = [];
	const recovered: string[] = [];
	const drain = Promise.withResolvers<void>();
	const register = (id: string, lines: string[], capabilities: string[], blocked = false) => {
		writer.registerConnection(
			id,
			{
				writeRaw: (line) => lines.push(line),
				waitForBackpressure: () => (blocked ? drain.promise : Promise.resolve()),
			},
			{ maxQueueBytes: blocked ? 512 : 1024 * 1024 },
		);
		writer.setConnectionCapabilities(id, capabilities);
		writer.attachConnectionToSession(id, "session");
	};
	register("live", live, eager ? [MEDIA_PLACEHOLDERS_CAPABILITY] : []);
	register("recover", recovered, ["event_resync"], true);
	const message = {
		role: "toolResult",
		toolCallId: "call",
		content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
	};
	const accepted = { type: "message_start", message };
	const frozen = JSON.stringify({ ...accepted, sessionId: "session" });
	const placeholder = `${JSON.stringify(omitInlineMedia(JSON.parse(frozen)))}\n`;
	const parse = vi.spyOn(JSON, "parse");
	const reparses = () => parse.mock.calls.filter(([line]) => line === `${frozen}\n`).length;
	try {
		writer.enqueue("session", accepted);
		expect(parse, "live placeholder and plain delivery must not reparse").not.toHaveBeenCalled();
		await writer.flushConnection("live");
		message.content[0].data = "bXV0YXRlZA==";
		// Message presence itself is immutable acceptance metadata, not re-read from the source.
		Reflect.deleteProperty(accepted, "message");
		register("late", replay, [MEDIA_PLACEHOLDERS_CAPABILITY]);
		await writer.flushConnection("late");
		expect(replay).toEqual([placeholder]);
		expect(reparses()).toBe(eager ? 0 : 1);
		// A second capable replay reuses only the derived string, not a cached parsed object.
		register("later", [], [MEDIA_PLACEHOLDERS_CAPABILITY]);
		expect(reparses()).toBe(eager ? 0 : 1);
		writer.enqueue("session", { type: "extension_event", name: "overflow", data: "x".repeat(1024) });
		drain.resolve();
		await writer.flush();
		const records: Record<string, unknown>[] = recovered.map((line) => JSON.parse(line));
		expect(records.find((record) => record.type === "resync_required" && record.sessionId)).toEqual({
			type: "resync_required",
			sessionId: "session",
			reason: "overflow",
			message: JSON.parse(frozen).message,
		});
		expect(live[0]).toBe(eager ? placeholder : `${frozen}\n`);
	} finally {
		parse.mockRestore();
		drain.resolve();
		for (const id of ["live", "recover", "late", "later"]) writer.unregisterConnection(id);
	}
});

it("retains question frames from their frozen JSON representation", async () => {
	const writer = new SessionEventWriter(() => {});
	const question = { type: "extension_ui_request", method: "question", id: "q", questions: [{ title: "original" }] };
	writer.enqueue("session", question);
	question.questions[0].title = "mutated";
	const replay: string[] = [];
	writer.registerConnection("late", {
		writeRaw: (line) => replay.push(line),
		waitForBackpressure: async () => {},
	});
	try {
		writer.attachConnectionToSession("late", "session");
		await writer.flush();
		expect(replay.map((line) => JSON.parse(line))).toEqual([
			{
				type: "extension_ui_request",
				method: "question",
				id: "q",
				sessionId: "session",
				questions: [{ title: "original" }],
				remainingMs: 0,
			},
		]);
	} finally {
		writer.unregisterConnection("late");
	}
});
