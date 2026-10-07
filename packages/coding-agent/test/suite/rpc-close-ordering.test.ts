import type { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { buildRpcSessionState } from "../../src/modes/rpc/connection-handler.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import type { HostToSessionWorker } from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { createHarness } from "./harness.ts";

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	const { EventEmitter } = await import("node:events");
	return {
		...actual,
		Worker: class extends EventEmitter {
			postMessage(): void {}
			terminate(): Promise<number> {
				return Promise.resolve(0);
			}
		},
	};
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function closeFixture() {
	const harness = await createHarness();
	const state = buildRpcSessionState(harness.session);
	const sessionPath = `${harness.tempDir}/session.jsonl`;
	vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
		this: EventEmitter,
		message: HostToSessionWorker,
	) {
		switch (message.type) {
			case "prepare":
				queueMicrotask(() => this.emit("message", { type: "prepared", request: message.request, sessionPath }));
				break;
			case "commit":
				queueMicrotask(() =>
					this.emit("message", {
						type: "ready",
						request: message.request,
						snapshot: { state, sessionPath, liveSessionPaths: [sessionPath], busy: false, streaming: false },
					}),
				);
				break;
			case "bind":
			case "command":
			case "prompt_surface":
			case "browser_engine":
			case "permission_preset":
				queueMicrotask(() => this.emit("message", { type: "result", request: message.request }));
				break;
			case "close":
			case "cancel_ui":
				break;
			default: {
				const exhaustive: never = message;
				throw new Error(`Unexpected message ${exhaustive}`);
			}
		}
	});
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc"]),
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			appMode: "rpc",
		},
		closeGraceMs: 100,
		now: () => 0,
	});
	const records: unknown[] = [];
	const observations: Array<Promise<RpcResponse | undefined>> = [];
	const writer = new SessionEventWriter((line) => {
		const record: unknown = JSON.parse(line);
		records.push(record);
		if (
			typeof record === "object" &&
			record !== null &&
			(("type" in record && record.type === "session_closed") ||
				("command" in record && record.command === "close_session"))
		) {
			observations.push(router.handle({ type: "list_sessions", id: "immediate" }));
		}
	});
	const router = new SessionCommandRouter(registry, writer, { cwd: harness.tempDir });
	await router.handle({ type: "open_session", cwd: harness.tempDir });
	await writer.flush();
	const entry = registry.list()[0];
	if (!entry) throw new Error("Expected open session");
	const client = registry.peek(entry.sessionId)?.worker;
	if (!client) throw new Error("Expected session worker client");
	records.length = 0;
	return {
		registry,
		router,
		writer,
		records,
		observations,
		client,
		sessionId: entry.sessionId,
		async [Symbol.asyncDispose]() {
			client.quarantine();
			client.worker.emit("exit", 0);
			await client.exited;
			await router.dispose();
			harness.cleanup();
		},
	};
}

// #1656: only worker transport is controlled; real requests, exit callback, registry, router and writer execute.
it("publishes successful close only after native exit removes ownership", async () => {
	// Given: the worker transport holds exit beyond the grace deadline.
	await using host = await closeFixture();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	// When: close reaches its deadline before the worker exit is delivered.
	const closing = host.router.handle({ type: "close_session", id: "close", sessionId: host.sessionId });
	await vi.advanceTimersByTimeAsync(100);
	await host.writer.flush();
	const beforeExit = [...host.records];
	const retained = host.registry.size;
	host.client.worker.emit("exit", 0);
	await closing;
	await host.writer.flush();
	// Then: both terminal records observe the real removal, never the deadline.
	expect(beforeExit).toEqual([]);
	expect(retained).toBe(1);
	expect(host.records).toEqual([
		{ type: "session_closed", sessionId: host.sessionId, reason: "client_close" },
		{ id: "close", type: "response", command: "close_session", success: true, data: {}, sessionId: host.sessionId },
	]);
	expect(await Promise.all(host.observations)).toEqual(
		Array(2).fill({
			id: "immediate",
			type: "response",
			command: "list_sessions",
			success: true,
			data: { sessions: [] },
		}),
	);
});

it.each(["error", "failure"] as const)(
	"defers terminal failure publication until ownership removal (%s)",
	async (kind) => {
		// Given: a bound worker whose termination acknowledgement is held.
		await using host = await closeFixture();
		// When: an error event or failure frame initiates quarantine before exit.
		switch (kind) {
			case "error":
				host.client.worker.emit("error", new Error("worker-failed"));
				break;
			case "failure":
				host.client.worker.emit("message", { type: "failure", error: "worker-failed" });
				break;
			default: {
				const exhaustive: never = kind;
				throw new Error(`Unexpected failure ${exhaustive}`);
			}
		}
		await host.writer.flush();
		const beforeExit = [...host.observations];
		host.client.worker.emit("exit", 1);
		await host.client.exited;
		await host.writer.flush();
		// Then: error identity is retained but no terminal record precedes removal.
		expect(beforeExit).toEqual([]);
		expect(host.records).toContainEqual({
			type: "session_closed",
			sessionId: host.sessionId,
			reason: "error",
		});
		expect(host.records).toContainEqual({
			type: "response",
			command: "close_session",
			success: false,
			error: "worker-failed",
			sessionId: host.sessionId,
		});
		expect(await Promise.all(host.observations)).toEqual(
			Array(2).fill({
				id: "immediate",
				type: "response",
				command: "list_sessions",
				success: true,
				data: { sessions: [] },
			}),
		);
	},
);
