import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { parseArgs } from "../../src/cli/args.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import type { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";

const allocations = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:worker_threads", async (original) => {
	const actual = await original<typeof import("node:worker_threads")>();
	return {
		...actual,
		Worker: class extends actual.Worker {
			constructor(...args: ConstructorParameters<typeof actual.Worker>) {
				super(...args);
				allocations.count++;
			}
		},
	};
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
		}
		const first = opened[0];
		if (!first) throw new Error("No first session");
		const original = registry.peek(first.sessionId);
		expect(original?.attachments).toBe(1);
		expect(registry.size).toBe(SESSION_WORKER_LIMITS.workers);
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
