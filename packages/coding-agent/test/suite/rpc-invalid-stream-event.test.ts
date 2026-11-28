import { describe, expect, test } from "vitest";
import { createRpcStdoutSink } from "../../src/modes/rpc/rpc-stdout-sink.ts";

// Wire contract of the stdio RPC host (senpi#7658): a stream event its serializer rejects is answered with
// `invalid_stream_event` and ends the host with exit code 1, instead of the error escaping the event flush.
// oh-my-openagent used to inject this guard into the installed dist/modes/rpc/rpc-mode.js (bin/lib/rpc-stream-errors.js).

function stdioHost() {
	const lines: string[] = [];
	const exited = Promise.withResolvers<number>();
	const shutdowns: number[] = [];
	const sink = createRpcStdoutSink({
		write: (chunk) => {
			lines.push(...chunk.split("\n").filter((line) => line.length > 0));
		},
		waitForBackpressure: async () => {},
		shutdown: (exitCode) => {
			shutdowns.push(exitCode);
			exited.resolve(exitCode);
		},
	});
	return {
		sink,
		shutdowns,
		exited: exited.promise,
		records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
	};
}

const assistant = { role: "assistant", content: [], usage: { totalTokens: 20 } };

describe("RPC stdio serializer guard", () => {
	test.each([
		[
			"a toolcall_start whose content is not a tool call",
			{
				type: "message_update",
				sessionId: "session-a",
				message: assistant,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: assistant },
			},
		],
		[
			"a message_update that carries a user message",
			{ type: "message_update", message: { role: "user", content: "bad" } },
		],
	])("answers %s with invalid_stream_event and shuts down with exit code 1", async (_name, event) => {
		// Given
		const host = stdioHost();

		// When: the session's event stream hands the sink an event the JSON projection rejects.
		expect(() => host.sink.writeRaw(`${JSON.stringify(event)}\n`)).not.toThrow();

		// Then: the client reads one prompt failure naming the cause, and the host shuts down once, with 1.
		const [record] = host.records();
		expect(record).toMatchObject({
			type: "response",
			command: "prompt",
			success: false,
			errorCode: "invalid_stream_event",
		});
		expect(String(record?.error)).not.toBe("");
		expect(record?.sessionId).toBe((event as { sessionId?: string }).sessionId);
		expect(await host.exited).toBe(1);
		expect(host.shutdowns).toEqual([1]);
	});

	test("passes well-formed events through unchanged and keeps the host running", async () => {
		// Given
		const host = stdioHost();

		// When
		host.sink.writeRaw(`${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({ type: "agent_end" })}\n`);
		await Promise.resolve();

		// Then
		expect(host.records()).toEqual([{ type: "agent_start" }, { type: "agent_end" }]);
		expect(host.shutdowns).toEqual([]);
	});
});
