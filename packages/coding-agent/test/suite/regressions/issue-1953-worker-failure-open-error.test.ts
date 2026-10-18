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

function workerThatReportsFailureDuringCommit(sessionPath: string, reason: string) {
	return (callbacks: { failure: (error: string) => void }): SessionWorkerClient =>
		({
			prepare: async () => sessionPath,
			commit: async () => {
				callbacks.failure(reason);
				return { state: { sessionId: "unused", cwd: "/" } };
			},
			quarantine: () => {},
		}) as unknown as SessionWorkerClient;
}

describe("issue 1953: a worker that fails during open", () => {
	it("reports the failure, not session_closing", async () => {
		// given: a worker-runtime registry whose next worker will fail mid-commit
		const scratch = await mkdtemp(join(tmpdir(), "senpi-1953-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const sessionPath = join(scratch, "session.jsonl");
		const registry = new WorkerSessionRegistry({
			configuration: {
				parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
				cwd: scratch,
				agentDir: join(scratch, "agent"),
				appMode: "rpc",
			},
			closeGraceMs: 100,
			now: Date.now,
			createWorker: workerThatReportsFailureDuringCommit(sessionPath, "worker-failed"),
		});

		// when: the client opens a session nothing else holds
		const opened = registry.openSession({ cwd: scratch });

		// then: the error names the worker failure instead of claiming the session is closing
		const error = await opened.then(
			() => undefined,
			(cause: unknown) => cause,
		);
		expect(error).toBeInstanceOf(RpcSessionRegistryError);
		const code = (error as RpcSessionRegistryError).code;
		expect(code).not.toBe("session_closing");
		expect(code).toBe("open_failed");
		expect((error as RpcSessionRegistryError).message).toContain("worker-failed");
	});
});
