import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { RpcSessionRegistryError } from "../../../src/modes/rpc/session-registry.ts";
import type { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import { WorkerSessionRegistry } from "../../../src/modes/rpc/worker-session-registry.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A worker that cannot load its modules: it reports the failure and exits before the open claims its path. */
function workerThatDiesWhileLoading(sessionPath: string, reason: string) {
	return (callbacks: { failure: (error: string) => void; exit: () => unknown }): SessionWorkerClient =>
		({
			prepare: async () => {
				callbacks.failure(reason);
				await callbacks.exit();
				return sessionPath;
			},
			commit: async () => ({ state: { sessionId: "unused", cwd: "/" } }),
			quarantine: () => {},
		}) as unknown as SessionWorkerClient;
}

/**
 * A real worker that cannot load: the load error reaches failure(), and quarantine rejects the still-pending prepare
 * with a plain request-channel error (session_closing, or session_worker_exited when the thread exits first).
 */
function workerWhosePrepareRejects(reason: string, channelError: string) {
	return (callbacks: { failure: (error: string) => void }): SessionWorkerClient =>
		({
			prepare: async () => {
				callbacks.failure(reason);
				throw new Error(channelError);
			},
			commit: async () => ({ state: { sessionId: "unused", cwd: "/" } }),
			quarantine: () => {},
		}) as unknown as SessionWorkerClient;
}

async function openError(createWorker: ConstructorParameters<typeof WorkerSessionRegistry>[0]["createWorker"]) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-4037-"));
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 100,
		now: Date.now,
		createWorker,
	});
	return registry.openSession({ cwd: scratch }).then(
		() => undefined,
		(cause: unknown) => cause,
	);
}

describe("issue 4037: a worker that dies while loading", () => {
	it.each(["session_closing", "session_worker_exited"])(
		"reports open_failed when the failed worker's prepare rejects with %s",
		async (channelError) => {
			// given: the next worker fails to load, so its pending prepare is rejected by the closing request channel
			const reason = "Cannot find module '/pkg/dist/node/provider-scope.js'";
			// when: the client opens a session nothing else holds
			const error = await openError(workerWhosePrepareRejects(reason, channelError));
			// then: the client learns why the worker died instead of a channel-closing code
			expect(error).toBeInstanceOf(RpcSessionRegistryError);
			expect((error as RpcSessionRegistryError).code).toBe("open_failed");
			expect((error as RpcSessionRegistryError).message).toContain("Cannot find module");
		},
	);

	it("reports open_failed with the load error, not session_closing", async () => {
		// given: a worker-runtime registry whose next worker fails to load and exits before the path is claimed
		const scratch = await mkdtemp(join(tmpdir(), "senpi-4037-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const sessionPath = join(scratch, "session.jsonl");
		const reason = "Cannot find module '/pkg/dist/node/provider-scope.js'";
		const registry = new WorkerSessionRegistry({
			configuration: {
				parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
				cwd: scratch,
				agentDir: join(scratch, "agent"),
				appMode: "rpc",
			},
			closeGraceMs: 100,
			now: Date.now,
			createWorker: workerThatDiesWhileLoading(sessionPath, reason),
		});

		// when: the client opens a session nothing else holds
		const error = await registry.openSession({ cwd: scratch }).then(
			() => undefined,
			(cause: unknown) => cause,
		);

		// then: the client learns why the worker died instead of being told the session is closing
		expect(error).toBeInstanceOf(RpcSessionRegistryError);
		expect((error as RpcSessionRegistryError).code).toBe("open_failed");
		expect((error as RpcSessionRegistryError).message).toContain("Cannot find module");
	});
});
