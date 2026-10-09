import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deferWhileSessionOpen, type ScheduledPromptEvent } from "../../src/cli/schedule-delivery.ts";
import { runDueJobs } from "../../src/cli/schedule-runner.ts";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../src/core/agent-session-runtime.ts";
import { resolveMovedPath } from "../../src/core/extensions/builtin/moved-path-guard/resolve.ts";
import { createScheduledJob, listScheduledJobs } from "../../src/core/extensions/builtin/schedule/store.ts";
import { holdSessionFile, liveSessionHolders } from "../../src/core/session-holders.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { createMovedLayout, type MovedLayout, writeSessionHeader } from "./moved-path-guard-fixtures.ts";

/**
 * code-yeongyu/senpi#2898: a session or schedule job created before the OmO desktop moved its data home names
 * the old root. `open_session`, schedule delivery, and session-holder claims resolve those paths through the
 * breadcrumb, so they open the new files without any session or job file being rewritten.
 */

const T0 = Date.parse("2026-10-07T12:00:00Z");
const SESSION_ID = "0199f0d4-1c3a-7bb1-9d2e-0a1b2c3d4e5f";

function recordingFactory(cwds: string[]): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		new ProjectTrustStore(options.agentDir).set(options.cwd, true);
		cwds.push(options.cwd);
		return {
			session: {
				sessionManager: options.sessionManager,
				agentDir: options.agentDir,
				extensionRunner: { hasHandlers: () => false, emit: async () => {} },
				abort: async () => {},
				abortBash: () => {},
				waitForIdle: async () => {},
				dispose: () => {},
			},
			services: { cwd: options.cwd, agentDir: options.agentDir },
			diagnostics: [],
		} as unknown as CreateAgentSessionRuntimeResult;
	};
}

describe("moved path resolution (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const dirs: string[] = [];

	afterEach(async () => {
		while (layouts.length > 0) layouts.pop()?.cleanup();
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	function movedSession() {
		const layout = createMovedLayout();
		layouts.push(layout);
		const newSession = join(layout.newSessions, "s.jsonl");
		writeSessionHeader(newSession, SESSION_ID, layout.newWorktree);
		return { layout, newSession, oldSession: join(layout.oldSessions, "s.jsonl") };
	}

	it("open_session with an old sessionPath and cwd opens the new ones", async () => {
		const { layout, newSession, oldSession } = movedSession();
		const cwds: string[] = [];
		const registry = new RpcSessionRegistry({ agentDir: layout.home, createRuntime: recordingFactory(cwds) });

		const opened = await registry.openSession({ cwd: layout.oldWorktree, sessionPath: oldSession });

		expect(opened.sessionPath).toBe(newSession);
		expect(opened.durableSessionId).toBe(SESSION_ID);
		expect(cwds).toEqual([layout.newWorktree]);
		expect(registry.list()[0]).toMatchObject({ sessionPath: newSession, cwd: layout.newWorktree });
		await registry.close(opened.sessionId);
	});

	// Review L3: a moved session file that is gone is an error naming where it should be, never a fresh session.
	it("open_session refuses an old session path whose moved file is missing", async () => {
		const { layout } = movedSession();
		const cwds: string[] = [];
		const registry = new RpcSessionRegistry({ agentDir: layout.home, createRuntime: recordingFactory(cwds) });

		await expect(
			registry.openSession({ cwd: layout.oldWorktree, sessionPath: join(layout.oldSessions, "gone.jsonl") }),
		).rejects.toMatchObject({
			code: "open_failed",
			message: expect.stringContaining(join(layout.newSessions, "gone.jsonl")),
		});
		expect(cwds).toEqual([]);
	});

	it("an open of the old path attaches to the session already open on the new path", async () => {
		const { layout, newSession, oldSession } = movedSession();
		const registry = new RpcSessionRegistry({ agentDir: layout.home, createRuntime: recordingFactory([]) });

		const first = await registry.openSession({ cwd: layout.newWorktree, sessionPath: newSession });
		const second = await registry.openSession({ cwd: layout.oldWorktree, sessionPath: oldSession });

		expect(second).toMatchObject({ sessionId: first.sessionId, attached: true });
		await registry.close(first.sessionId);
	});

	// Sixth review LOW-3: the synchronous resolver (session and schedule cwd) maps a .git it cannot read (here ELOOP)
	// to "unknown" like the async probe, so it keeps the remembered re-used answer instead of moving a live worktree.
	it("a re-used worktree cwd stays put when its .git becomes unreadable", () => {
		const { layout } = movedSession();
		mkdirSync(layout.oldWorktree, { recursive: true });
		writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
		expect(resolveMovedPath(join(layout.oldWorktree, "src"))).toBe(join(layout.oldWorktree, "src"));
		rmSync(join(layout.oldWorktree, ".git"));
		symlinkSync(".git", join(layout.oldWorktree, ".git"));

		expect(resolveMovedPath(join(layout.oldWorktree, "src"))).toBe(join(layout.oldWorktree, "src"));
	});

	it("a holder claim on the old path is a claim on the new path", async () => {
		const { newSession, oldSession } = movedSession();
		const hold = holdSessionFile(oldSession, SESSION_ID, { expectExisting: true });
		try {
			expect((await liveSessionHolders(newSession, SESSION_ID)).map((holder) => holder.pid)).toEqual([process.pid]);
			await expect(
				deferWhileSessionOpen({
					version: 1,
					id: "job",
					sessionId: SESSION_ID,
					sessionFile: newSession,
					cwd: "/",
					prompt: "p",
					dueAt: T0,
					everyMs: null,
					createdAt: T0,
					fireCount: 0,
					lastFiredAt: null,
					lastError: null,
				}),
			).resolves.toContain(`pid ${process.pid}`);
		} finally {
			hold.release();
		}
	});

	it("a schedule job created with old paths delivers with the new ones and keeps its own file", async () => {
		const { layout, newSession, oldSession } = movedSession();
		const dir = join(await mkdtemp(join(tmpdir(), "senpi-moved-schedule-")), "schedule");
		dirs.push(dir);
		await createScheduledJob(
			dir,
			{
				sessionId: SESSION_ID,
				sessionFile: oldSession,
				cwd: layout.oldWorktree,
				prompt: "p",
				dueAt: T0,
				everyMs: 60_000,
			},
			T0 - 1,
		);
		const events: ScheduledPromptEvent[] = [];

		await runDueJobs({
			dir,
			now: () => T0 + 1,
			owner: { pid: 101, processStartedAtMs: 1_000 },
			runners: async () => [],
			deliver: async (event) => {
				events.push(event);
				return { ok: true };
			},
		});

		expect(events).toEqual([expect.objectContaining({ sessionFile: newSession, cwd: layout.newWorktree })]);
		expect((await listScheduledJobs(dir)).jobs.map(({ job }) => [job.sessionFile, job.cwd])).toEqual([
			[oldSession, layout.oldWorktree],
		]);
	});
});
