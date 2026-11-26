import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { parseArgs } from "../../src/cli/args.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import type { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import {
	type HostToSessionWorker,
	SESSION_WORKER_LIMITS,
	type SessionWorkerToHost,
	type WorkerSnapshot,
} from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";

const allocations = vi.hoisted((): { count: number; real: number; snapshot: WorkerSnapshot | undefined } => ({
	count: 0,
	real: 0,
	snapshot: undefined,
}));
vi.mock("node:worker_threads", async (original) => {
	const actual = await original<typeof import("node:worker_threads")>();
	const { EventEmitter } = await import("node:events");
	// #1983: only the attached session needs a runtime. Capacity fillers still drive the real
	// SessionWorkerClient request channel, registry admission, binding and exit callbacks.
	function Worker(...args: ConstructorParameters<typeof actual.Worker>) {
		allocations.count++;
		if (allocations.count === 1) {
			allocations.real++;
			return new actual.Worker(...args);
		}
		const seed = allocations.snapshot;
		if (!seed?.state.sessionFile) throw new Error("Capacity filler preceded the real session");
		const sessionId = randomUUID();
		const sessionPath = join(dirname(seed.state.sessionFile), `${sessionId}.jsonl`);
		const snapshot: WorkerSnapshot = {
			...seed,
			state: { ...seed.state, sessionId, sessionFile: sessionPath },
			sessionPath,
			liveSessionPaths: [sessionPath],
		};
		return new (class extends EventEmitter {
			postMessage(message: HostToSessionWorker): void {
				let response: SessionWorkerToHost;
				switch (message.type) {
					case "prepare":
						response = { type: "prepared", request: message.request, sessionPath };
						break;
					case "commit":
						response = { type: "ready", request: message.request, snapshot, bootstrap: { transcript: [] } };
						break;
					case "bind":
						response = { type: "result", request: message.request };
						break;
					case "cancel_ui":
						response = { type: "control_done", control: "cancel_ui" };
						break;
					case "close":
						void this.terminate();
						return;
					default:
						throw new Error(`Unexpected capacity filler request: ${message.type}`);
				}
				queueMicrotask(() => this.emit("message", response));
			}
			terminate(): Promise<number> {
				queueMicrotask(() => this.emit("exit", 0));
				return Promise.resolve(0);
			}
		})();
	}
	return { ...actual, Worker: vi.fn(Worker) };
});

const openedSchema = z.object({
	type: z.literal("response"),
	command: z.literal("open_session"),
	success: z.literal(true),
	data: z.object({
		sessionId: z.string(),
		attached: z.boolean().optional(),
		state: z.object({ sessionId: z.string(), sessionFile: z.string() }),
	}),
});

it("attaches at full worker capacity without allocating a worker or releasing the original attachment", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-worker-capacity-test-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	vi.stubEnv("PATH", "/usr/bin:/bin");
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd,
			agentDir,
			appMode: "rpc",
		},
		closeGraceMs: 1000,
		now: Date.now,
	});
	let latest: unknown;
	const writer = new SessionEventWriter((line) => {
		latest = JSON.parse(line);
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	const workers: SessionWorkerClient[] = [];
	const originalPath = join(scratch, "original.jsonl");
	try {
		const opened = [];
		for (let i = 0; i < SESSION_WORKER_LIMITS.workers; i++) {
			expect(
				await router.handle({ type: "open_session", cwd, ...(i === 0 ? { sessionPath: originalPath } : {}) }),
			).toBeUndefined();
			await writer.flush();
			const response = openedSchema.parse(latest);
			opened.push(response.data);
			const worker = registry.peek(response.data.sessionId)?.worker;
			if (!worker) throw new Error("Opened session has no worker");
			workers.push(worker);
			if (i === 0) allocations.snapshot = worker.snapshot;
		}
		const first = opened[0];
		if (!first) throw new Error("No first session");
		const original = registry.peek(first.sessionId);
		expect(original?.attachments).toBe(1);
		expect(registry.size).toBe(SESSION_WORKER_LIMITS.workers);
		expect(allocations.count).toBe(SESSION_WORKER_LIMITS.workers);
		expect(allocations.real).toBe(1);
		const before = allocations.count;
		for (const sessionPath of [first.state.sessionFile, originalPath]) {
			const attachError = await router.handle({ type: "open_session", cwd, sessionPath });
			expect(attachError).toBeUndefined();
			await writer.flush();
			const attached = openedSchema.parse(latest);
			expect(attached.data).toMatchObject({
				attached: true,
				sessionId: first.sessionId,
				state: { sessionId: first.state.sessionId },
			});
			expect(allocations.count).toBe(before);
			expect(registry.size).toBe(SESSION_WORKER_LIMITS.workers);
			expect(registry.peek(first.sessionId)?.worker).toBe(workers[0]);
			expect(original?.attachments).toBe(2);
			await router.handle({ type: "close_session", sessionId: first.sessionId });
			await writer.flush();
			expect(original?.attachments).toBe(1);
			expect(original?.state).toBe("open");
		}
		await router.handle({ type: "get_state", sessionId: first.sessionId });
		await writer.flush();
		expect(latest).toMatchObject({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: first.state.sessionId },
		});
	} finally {
		await router.dispose();
		await Promise.all(workers.map((worker) => worker.exited));
		vi.unstubAllEnvs();
		await rm(scratch, { recursive: true, force: true });
	}
}, 120_000);
