import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { opened } from "../rpc-inprocess-host-metrics.ts";

// senpi #2206. A task owner deletes a finished child's directory while the shared host still
// retains that child's session; every later list() and open threw ENOENT, refusing every child.
it("keeps serving opens after a retained session's directory is deleted, and ends that session", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-vanished-session-dir-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	const childDir = join(scratch, "children", "st_gone", "sessions");
	await mkdir(cwd);
	await mkdir(agentDir);
	await mkdir(childDir, { recursive: true });
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1000,
	});
	let latest: unknown;
	const writer = new SessionEventWriter((line) => {
		latest = JSON.parse(line);
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	try {
		// Given: a retained session inside a task child's directory whose last client went away.
		const gonePath = join(childDir, "st_gone.jsonl");
		const openGone = { type: "open_session", cwd, sessionPath: gonePath, retain_on_disconnect: true } as const;
		expect(await router.handle(openGone)).toBeUndefined();
		await writer.flush();
		const gone = opened(latest, 0);
		registry.beginClose(gone.sessionId, undefined, { detach: true });
		expect(registry.peek(gone.sessionId)?.attachments).toBe(0);

		// When: the owner deletes the child's whole directory.
		await rm(join(scratch, "children"), { recursive: true, force: true });

		// Then: listing does not throw, and a session at another path opens.
		expect(() => registry.list()).not.toThrow();
		const freshPath = join(scratch, "fresh", "st_fresh.jsonl");
		await mkdir(join(scratch, "fresh"));
		expect(await router.handle({ type: "open_session", cwd, sessionPath: freshPath })).toBeUndefined();
		await writer.flush();
		expect(opened(latest, 0).sessionId).not.toBe(gone.sessionId);

		// And: the next sweep ends the session whose directory vanished.
		router.sweepIdleSessions();
		const ending = registry.peek(gone.sessionId);
		expect(ending?.state ?? "closed").not.toBe("open");
		await ending?.closeCompletion;
		expect(registry.list().map((row) => row.sessionId)).not.toContain(gone.sessionId);
	} finally {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	}
}, 120_000);
