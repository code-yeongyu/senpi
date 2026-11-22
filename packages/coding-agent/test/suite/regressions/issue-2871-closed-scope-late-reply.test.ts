import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { RpcConnectionSink } from "../../../src/modes/rpc/connection-handler.ts";
import { createRpcSessionBinding } from "../../../src/modes/rpc/session-binding.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import type { RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";

// senpi#2871: a child's first prompt waits for its acknowledgement under the client's request deadline.
// On a starved host loop the prompt's preflight outlives that deadline, the client discards the session
// (closing its provider scope), and the host then answers the prompt through the session sink - a write
// into a CLOSED scope. That write threw "Provider scope is closed" out of an unawaited prompt, once per
// late reply, on every long-lived host.

const connectionHandler = vi.hoisted(() => ({ sink: undefined as RpcConnectionSink | undefined }));

vi.mock("../../../src/modes/rpc/connection-handler.ts", () => ({
	createRpcConnectionHandler: (_runtime: unknown, sink: RpcConnectionSink) => {
		connectionHandler.sink = sink;
		return {
			ready: Promise.resolve(),
			handleInputLine: async () => {},
			cancelPendingExtensionUiRequests: () => {},
			pendingPrompts: () => [],
			dispose: async () => {},
		};
	},
}));

describe("issue 2871: a reply written after its session's scope closed", () => {
	const directories: string[] = [];
	afterEach(async () => {
		connectionHandler.sink = undefined;
		vi.restoreAllMocks();
		await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("is dropped with one line naming the session, never thrown", async () => {
		// Given: a bound session whose sink delivers to an attached connection
		const dir = await mkdtemp(join(tmpdir(), "senpi-2871-"));
		directories.push(dir);
		const delivered: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("client", {
			writeRaw: (line) => delivered.push(line),
			waitForBackpressure: async () => {},
		});
		const entry = {
			scope: new ProviderScope(),
			runtime: {} as AgentSessionRuntime,
		} as unknown as RpcSessionEntry;
		await createRpcSessionBinding("rpc-1", entry, writer, () => {});
		const sink = connectionHandler.sink;
		if (sink === undefined) throw new Error("the binding created no connection sink");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		// When: the client discarded the session (its scope closed) and the prompt's reply arrives late, twice
		entry.scope.close();
		const lateReply = `${JSON.stringify({ id: "req_1", type: "response", command: "prompt", success: true })}\n`;

		// Then: nothing throws, nothing is delivered, and exactly one line names the session
		expect(() => sink.writeRaw(lateReply)).not.toThrow();
		expect(() => sink.writeRaw(lateReply)).not.toThrow();
		await writer.flush();
		expect(delivered).toEqual([]);
		const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("rpc-1"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("closed session rpc-1");
	});
});
