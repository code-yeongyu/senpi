import { afterEach, describe, expect, test, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { runMultiSessionHost } from "../src/modes/rpc/multi-session-host.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("multi-session RPC input validation", () => {
	const stdinListeners = process.stdin.listeners("end") as NodeListener[];
	const signalListeners = new Map(
		(process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)).map((signal) => [
			signal,
			process.listeners(signal) as NodeListener[],
		]),
	);

	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		for (const listener of process.stdin.listeners("end") as NodeListener[]) {
			if (!stdinListeners.includes(listener)) process.stdin.off("end", listener);
		}
		for (const [signal, existing] of signalListeners) {
			for (const listener of process.listeners(signal) as NodeListener[]) {
				if (!existing.includes(listener)) process.off(signal, listener);
			}
		}
	});

	test("rejects valid non-object JSON without throwing", async () => {
		const createRuntime = vi.fn() as unknown as CreateAgentSessionRuntimeFactory;
		void runMultiSessionHost({ agentDir: "/tmp/senpi-rpc-test", createRuntime, cwd: "/tmp" });
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler?.("null");

		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual({
				type: "response",
				command: "parse",
				success: false,
				error: "RPC command must be a JSON object.",
			});
		});
		expect(createRuntime).not.toHaveBeenCalled();
	});
});
