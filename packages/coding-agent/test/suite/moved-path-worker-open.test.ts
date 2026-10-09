import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { createMovedLayout, type MovedLayout, writeSessionHeader } from "./moved-path-guard-fixtures.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// code-yeongyu/senpi#2898: the worker registry the multi-session host instantiates resolves moved paths too.

const SESSION_ID = "0199f0d4-1c3a-7bb1-9d2e-0a1b2c3d4e60";
const layouts: MovedLayout[] = [];

afterEach(() => {
	while (layouts.length > 0) layouts.pop()?.cleanup();
});

async function movedWorkerHost() {
	const layout = createMovedLayout();
	layouts.push(layout);
	const newSession = join(layout.newSessions, "s.jsonl");
	writeSessionHeader(newSession, SESSION_ID, layout.newWorktree);
	const host = await startWorkerHost();
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd: host.cwd,
			agentDir: join(host.scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 1000,
		now: Date.now,
	});
	return {
		layout,
		newSession,
		oldSession: join(layout.oldSessions, "s.jsonl"),
		host,
		registry,
		agentDir: join(host.scratch, "agent"),
	};
}

it("worker open_session with an old sessionPath and cwd opens the new ones", async () => {
	const { layout, newSession, oldSession, host, registry } = await movedWorkerHost();
	let handle: string | undefined;
	try {
		const opened = await registry.openSession({ cwd: layout.oldWorktree, sessionPath: oldSession });
		handle = opened.sessionId;

		expect(opened).toMatchObject({ sessionPath: newSession, durableSessionId: SESSION_ID });
		expect(registry.list()[0]).toMatchObject({ sessionPath: newSession, cwd: layout.newWorktree });
	} finally {
		if (handle) await registry.close(handle).catch(() => undefined);
		await host.dispose();
	}
}, 60_000);

it("an old-path open never starts a second writer on a session open under its new path", async () => {
	const { layout, newSession, oldSession, host, registry } = await movedWorkerHost();
	const handles: string[] = [];
	try {
		handles.push((await registry.openSession({ cwd: layout.newWorktree, sessionPath: newSession })).sessionId);

		// The open is routed to the live owner of the new path: with no client bound to it here, that
		// attach is refused, which is the proof no second worker took the file.
		const second = registry.openSession({ cwd: layout.oldWorktree, sessionPath: oldSession });
		second.then((opened) => handles.push(opened.sessionId)).catch(() => undefined);

		await expect(second).rejects.toMatchObject({ code: "session_path_in_use" });
	} finally {
		for (const handle of handles) await registry.close(handle).catch(() => undefined);
		await host.dispose();
	}
}, 60_000);

// Review L2: a NEW session opened with an old cwd is filed under the moved cwd's session directory.
it("worker files a new session opened with an old cwd under the moved cwd", async () => {
	const { layout, host, registry, agentDir } = await movedWorkerHost();
	let handle: string | undefined;
	try {
		const opened = await registry.openSession({ cwd: layout.oldWorktree });
		handle = opened.sessionId;

		expect(basename(dirname(opened.sessionPath ?? ""))).toBe(
			basename(getDefaultSessionDir(layout.newWorktree, agentDir)),
		);
	} finally {
		if (handle) await registry.close(handle).catch(() => undefined);
		await host.dispose();
	}
}, 60_000);

// Review L3: an old session path whose moved file is gone fails instead of starting a fresh session there.
it("worker refuses an old session path whose moved file is missing", async () => {
	const { layout, host, registry } = await movedWorkerHost();
	const gone = join(layout.oldSessions, "gone.jsonl");
	try {
		// Re-review L2: the same typed refusal the in-process registry gives, so the wire answer is identical.
		await expect(registry.openSession({ cwd: layout.oldWorktree, sessionPath: gone })).rejects.toMatchObject({
			name: "RpcSessionRegistryError",
			code: "open_failed",
			message: expect.stringContaining(join(layout.newSessions, "gone.jsonl")),
		});
	} finally {
		await host.dispose();
	}
}, 60_000);

// Re-review L2, on the wire: the worker host answers open_session with the in-process registry's error text.
it("worker host answers a missing moved session file with the registry's open_failed text", async () => {
	const { layout, host, registry } = await movedWorkerHost();
	const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: host.cwd });
	try {
		const response = await router.handle({
			id: "open",
			type: "open_session",
			cwd: layout.oldWorktree,
			sessionPath: join(layout.oldSessions, "gone.jsonl"),
		});

		expect(response).toMatchObject({
			success: false,
			error: `open_failed: moved session file does not exist: ${join(layout.newSessions, "gone.jsonl")}`,
		});
	} finally {
		await host.dispose();
	}
}, 60_000);
