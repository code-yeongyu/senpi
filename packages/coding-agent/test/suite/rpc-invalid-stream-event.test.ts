import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { RpcConnectionSink } from "../../src/modes/rpc/connection-handler.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "./harness.ts";

// The stdio RPC host answers a stream event its serializer rejects on the wire and shuts down, instead of letting the
// error escape the event flush. oh-my-openagent used to inject this guard into the installed dist/modes/rpc/rpc-mode.js
// (its bin/lib/rpc-stream-errors.js); it now lives here so that text patch can go.

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	sink: undefined as RpcConnectionSink | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn(() => () => {}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

vi.mock("../../src/modes/rpc/connection-handler.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/rpc/connection-handler.ts")>();
	return {
		...actual,
		createRpcConnectionHandler: (...args: Parameters<typeof actual.createRpcConnectionHandler>) => {
			rpcIo.sink = args[1];
			return actual.createRpcConnectionHandler(...args);
		},
	};
});

type NodeListener = Parameters<typeof process.on>[1];

function listenerSnapshot(): Map<NodeJS.Signals | "end", NodeListener[]> {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return new Map<NodeJS.Signals | "end", NodeListener[]>([
		["end", process.stdin.listeners("end") as NodeListener[]],
		...signals.map((signal): [NodeJS.Signals, NodeListener[]] => [
			signal,
			process.listeners(signal) as NodeListener[],
		]),
	]);
}

function restoreListeners(snapshot: Map<NodeJS.Signals | "end", NodeListener[]>): void {
	for (const [name, previous] of snapshot) {
		const current = (name === "end" ? process.stdin.listeners("end") : process.listeners(name)) as NodeListener[];
		for (const listener of current) {
			if (previous.includes(listener)) continue;
			if (name === "end") process.stdin.off("end", listener);
			else process.off(name, listener);
		}
	}
}

function outputRecords(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((chunk) => chunk.split("\n"))
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const assistant = { role: "assistant", content: [], usage: { totalTokens: 20 } };

describe("RPC stdio serializer guard", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.sink = undefined;
		vi.restoreAllMocks();
	});

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
		// Given: a stdio RPC host whose process exit is observed instead of taken.
		const snapshot = listenerSnapshot();
		const harness = await createHarness();
		const exited = Promise.withResolvers<number | undefined>();
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exited.resolve(code);
			return undefined as never;
		}) as typeof process.exit);
		try {
			void runRpcMode({
				session: harness.session,
				newSession: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
				dispose: vi.fn(async () => {}),
				setRebindSession: vi.fn(),
				onBeforeSessionReplace: vi.fn(() => () => {}),
			} as unknown as AgentSessionRuntime);
			const sink = rpcIo.sink;
			expect(sink).toBeDefined();

			// When: the session's event stream hands the sink an event the JSON projection rejects.
			expect(() => sink?.writeRaw(`${JSON.stringify(event)}\n`)).not.toThrow();

			// Then: the client reads one prompt failure naming the cause, and the host exits with 1.
			const [record] = outputRecords();
			expect(record).toMatchObject({
				type: "response",
				command: "prompt",
				success: false,
				errorCode: "invalid_stream_event",
			});
			expect(String(record?.error)).not.toBe("");
			expect(record?.sessionId).toBe((event as { sessionId?: string }).sessionId);
			expect(await exited.promise).toBe(1);
		} finally {
			harness.cleanup();
			restoreListeners(snapshot);
		}
	});

	test("passes well-formed events through unchanged", async () => {
		// Given
		const snapshot = listenerSnapshot();
		const harness = await createHarness();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
		try {
			void runRpcMode({
				session: harness.session,
				newSession: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
				dispose: vi.fn(async () => {}),
				setRebindSession: vi.fn(),
				onBeforeSessionReplace: vi.fn(() => () => {}),
			} as unknown as AgentSessionRuntime);

			// When
			rpcIo.sink?.writeRaw(`${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({ type: "agent_end" })}\n`);

			// Then
			expect(outputRecords()).toEqual([{ type: "agent_start" }, { type: "agent_end" }]);
			expect(exit).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
			restoreListeners(snapshot);
		}
	});
});
