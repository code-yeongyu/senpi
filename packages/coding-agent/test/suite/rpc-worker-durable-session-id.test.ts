import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

/**
 * #2010: the durable-session-id contract on the REAL worker-backed registry, which is what the
 * multi-session host instantiates. #1956 guarded only RpcSessionRegistry.
 */

const CHOSEN = "0199f0d4-1c3a-7bb1-9d2e-0a1b2c3d4e5f";

function makeRegistry(host: Awaited<ReturnType<typeof startWorkerHost>>) {
	return new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd: host.cwd,
			agentDir: join(host.scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 1000,
		now: Date.now,
	});
}

it("worker registry refuses a durable id a LIVE session already holds", async () => {
	const host = await startWorkerHost();
	const registry = makeRegistry(host);
	const handles: string[] = [];
	try {
		const first = await registry.openSession({
			cwd: host.cwd,
			sessionPath: join(host.scratch, "one.jsonl"),
			durableSessionId: CHOSEN,
		});
		handles.push(first.sessionId);
		expect(first.durableSessionId).toBe(CHOSEN);

		await expect(
			registry.openSession({
				cwd: host.cwd,
				sessionPath: join(host.scratch, "two.jsonl"),
				durableSessionId: CHOSEN,
			}),
		).rejects.toMatchObject({ code: "session_id_in_use" });
	} finally {
		for (const handle of handles) await registry.close(handle).catch(() => undefined);
		await host.dispose();
	}
}, 60_000);

it("worker registry refuses a malformed durable id at its own boundary", async () => {
	const host = await startWorkerHost();
	const registry = makeRegistry(host);
	try {
		await expect(
			registry.openSession({
				cwd: host.cwd,
				sessionPath: join(host.scratch, "bad.jsonl"),
				durableSessionId: "no spaces",
			}),
		).rejects.toMatchObject({ code: "invalid_session_id" });
		expect(registry.list()).toHaveLength(0);
	} finally {
		await host.dispose();
	}
}, 60_000);

it("a caller-chosen id is on disk immediately, so a reopen with no id reads it back", async () => {
	const host = await startWorkerHost();
	const registry = makeRegistry(host);
	const sessionPath = join(host.scratch, "chosen.jsonl");
	let handle: string | undefined;
	try {
		const created = await registry.openSession({ cwd: host.cwd, sessionPath, durableSessionId: CHOSEN });
		handle = created.sessionId;
		expect(created.durableSessionId).toBe(CHOSEN);
		// No assistant message was ever appended. The caller already holds this id in its own
		// records, so the file must answer to it now, not after the first reply.
		expect(existsSync(sessionPath)).toBe(true);
		expect(JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0] ?? "{}").id).toBe(CHOSEN);

		await registry.close(handle);
		handle = undefined;
		const reopened = await registry.openSession({ cwd: host.cwd, sessionPath });
		handle = reopened.sessionId;
		expect(reopened.durableSessionId).toBe(CHOSEN);
	} finally {
		if (handle) await registry.close(handle).catch(() => undefined);
		await host.dispose();
	}
}, 60_000);
