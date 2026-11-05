import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import { SESSION_WORKER_LIMITS, type WorkerSnapshot } from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";

type WorkerCallbacks = ConstructorParameters<typeof SessionWorkerClient>[0];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A worker-runtime registry whose workers are in-memory stand-ins: the admission path under
 * test (`openWorkerSession` and the registry around it) is production code, and no isolate is
 * started, so the count is exact and nothing depends on machine load (compare senpi#1983).
 */
async function workerRuntimeHost(options: { holdPrepare?: Promise<void> } = {}) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-x4-worker-cap-"));
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	let created = 0;
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 10_000,
		now: Date.now,
		createWorker: (callbacks: WorkerCallbacks) => {
			const serial = ++created;
			let snapshot: WorkerSnapshot | undefined;
			let path = "";
			return {
				get snapshot() {
					return snapshot;
				},
				get bindingReady() {
					return snapshot !== undefined;
				},
				busy: false,
				exited: Promise.resolve(),
				prepare: async (_configuration: unknown, profile: { sessionPath?: string }) => {
					await options.holdPrepare;
					path = profile.sessionPath ?? join(scratch, `session-${serial}.jsonl`);
					return path;
				},
				commit: async () => {
					snapshot = {
						state: { sessionId: `durable-${serial}`, sessionFile: path, cwd: scratch },
						sessionPath: path,
						liveSessionPaths: [path],
						busy: false,
						streaming: false,
					} as unknown as WorkerSnapshot;
					return snapshot;
				},
				close: async () => {
					await callbacks.exit();
				},
				quarantine: () => {},
			} as unknown as SessionWorkerClient;
		},
	});
	return {
		registry,
		scratch,
		get created() {
			return created;
		},
	};
}

async function refusal(open: Promise<unknown>): Promise<unknown> {
	return open.then(
		() => undefined,
		(cause: unknown) => cause,
	);
}

describe("X4: the worker runtime's per-host session worker cap", () => {
	it("is 20 workers", () => {
		expect(SESSION_WORKER_LIMITS.workers).toBe(20);
	});

	it("admits 20 sessions and refuses the 21st fresh open with too_many_sessions, starting no worker", async () => {
		// Given: a worker-runtime registry with 20 open sessions
		const host = await workerRuntimeHost();
		for (let i = 0; i < 20; i++) await host.registry.openSession({ cwd: host.scratch });
		expect(host.registry.size).toBe(20);
		expect(host.created).toBe(20);

		// When: a client opens one more session that names no held path
		const error = await refusal(host.registry.openSession({ cwd: host.scratch }));

		// Then: the open is refused with too_many_sessions and nothing was started for it
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("too_many_sessions");
		expect(host.created).toBe(20);
		expect(host.registry.size).toBe(20);
	});

	it("counts opens still in flight against the cap", async () => {
		// Given: 20 opens admitted whose workers have not finished preparing
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const host = await workerRuntimeHost({ holdPrepare: held });
		const pending = Array.from({ length: 20 }, () => host.registry.openSession({ cwd: host.scratch }));
		expect(host.registry.size).toBe(20);
		expect(host.registry.list().every((row) => row.status === "opening")).toBe(true);

		// When: a 21st open arrives before any of them commits
		const error = await refusal(host.registry.openSession({ cwd: host.scratch }));

		// Then: it is refused, and the 20 in-flight opens still complete
		expect((error as Error).message).toBe("too_many_sessions");
		expect(host.created).toBe(20);
		release();
		const opened = await Promise.all(pending);
		expect(opened).toHaveLength(20);
		expect(host.registry.list().every((row) => row.status === "open")).toBe(true);
	});

	it("attaches an open that names a held session path at capacity, without a worker", async () => {
		// Given: 20 open sessions, the first one holding a known session path
		const host = await workerRuntimeHost();
		const heldPath = join(host.scratch, "held.jsonl");
		const first = await host.registry.openSession({ cwd: host.scratch, sessionPath: heldPath });
		for (let i = 1; i < 20; i++) await host.registry.openSession({ cwd: host.scratch });
		expect(host.registry.size).toBe(20);

		// When: a client opens that path again
		const attached = await host.registry.openSession({ cwd: host.scratch, sessionPath: heldPath });

		// Then: the path attach is exempt from the cap: same session, no new worker, one more attachment
		expect(attached).toMatchObject({ attached: true, sessionId: first.sessionId, sessionPath: heldPath });
		expect(host.created).toBe(20);
		expect(host.registry.size).toBe(20);
		expect(host.registry.peek(first.sessionId)?.attachments).toBe(2);
	});

	it("frees exactly one slot when one session closes", async () => {
		// Given: a registry at the cap
		const host = await workerRuntimeHost();
		const opened = [];
		for (let i = 0; i < 20; i++) opened.push(await host.registry.openSession({ cwd: host.scratch }));
		const closing = opened[0];
		if (!closing) throw new Error("no session opened");

		// When: one session closes and its worker exits
		await host.registry.close(closing.sessionId);
		await host.registry.peek(closing.sessionId)?.closeCompletion;

		// Then: one fresh open is admitted and the next one is refused again
		expect(host.registry.size).toBe(19);
		await host.registry.openSession({ cwd: host.scratch });
		expect(host.registry.size).toBe(20);
		expect(host.created).toBe(21);
		const error = await refusal(host.registry.openSession({ cwd: host.scratch }));
		expect((error as Error).message).toBe("too_many_sessions");
		expect(host.created).toBe(21);
	});
});
