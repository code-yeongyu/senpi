import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import {
	CHILD_REAPER_ENV,
	createChildReaper,
	resolveChildReaperConfig,
	startHostChildReaper,
} from "../../src/modes/rpc/child-reaper.ts";
import { loadChildReaperSyscalls } from "../../src/modes/rpc/child-reaper-syscalls.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { fakeSyscalls, runOrphanReaperFixture, zombieChildCount } from "./rpc-host-reaper-support.ts";

/** Short child spawns routed through one session, matching the daemon's busiest path. */
const SPAWNS = 50;
/** The window the host cell is allowed to take before a surviving zombie is a leak. */
const SETTLE_DEADLINE_MS = 6_000;

const responseSchema = z.object({ id: z.string().optional(), success: z.boolean(), data: z.unknown() });

/**
 * Z-count for a pid, resolved as soon as it reaches zero. There is no kernel
 * event for "someone reaped my child", so the process table is re-read until the
 * deadline - the wait ends on the observation, never on a fixed sleep.
 */
async function settledZombieCount(pid: number, deadlineMs: number): Promise<number> {
	const deadline = Date.now() + deadlineMs;
	let count = zombieChildCount(pid);
	while (count > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		count = zombieChildCount(pid);
	}
	return count;
}

it("leaves no zombie child behind when one in-process session spawns 50 short children", async () => {
	// Given: a session on the in-process runtime the daemon selects for socket hosts.
	const scratch = await mkdtemp(join(tmpdir(), "dh-reaper-host-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
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
		closeGraceMs: 1_000,
	});
	const records = new Map<string, unknown>();
	const writer = new SessionEventWriter((line) => {
		const record: unknown = JSON.parse(line);
		const id = responseSchema.safeParse(record).data?.id;
		if (id !== undefined) records.set(id, record);
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	/** A command's response arrives inline or through the writer; both are the answer. */
	const request = async (command: Parameters<typeof router.handle>[0]) => {
		const id = `reaper-${records.size + 1}`;
		const inline = await router.handle({ ...command, id });
		await writer.flush();
		return responseSchema.parse(inline ?? records.get(id));
	};
	try {
		const opened = await request({ type: "open_session", cwd });
		expect(opened.success).toBe(true);
		const sessionId = z.object({ sessionId: z.string() }).parse(opened.data).sessionId;

		// When: the session runs 50 short commands, each of which spawns a child process.
		for (let spawn = 0; spawn < SPAWNS; spawn++) {
			expect((await request({ type: "bash", sessionId, command: "true" })).success).toBe(true);
		}

		// Then: the host process owns no exited-but-unclaimed child.
		expect(await settledZombieCount(process.pid, SETTLE_DEADLINE_MS)).toBe(0);
	} finally {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	}
}, 300_000);

it("reaps a waitable child only after it stayed waitable across two ticks the full window apart", () => {
	// Given: one child that exited the instant the reaper first saw it.
	const children = [{ pid: 4242, name: "sleep", waitable: true }];
	const syscalls = fakeSyscalls(children);
	let clock = 0;
	const reaper = createChildReaper({ syscalls, now: () => clock, minWaitableMs: 5_000 });

	// When: ticks run before the window elapses.
	reaper.tick();
	clock = 4_999;
	reaper.tick();

	// Then: the child is still the owner's to wait on.
	expect(syscalls.reaped).toEqual([]);
	expect(reaper.waitingPids).toEqual([4242]);

	// When: one more tick lands past the window.
	clock = 5_001;
	reaper.tick();

	// Then: it is reaped exactly once, by pid.
	expect(syscalls.reaped).toEqual([4242]);
	expect(children).toEqual([]);
});

it("never waits on a live child and never asks the kernel for pid -1", () => {
	// Given: a child that is running, not exited.
	const syscalls = fakeSyscalls([{ pid: 77, name: "bash", waitable: false }]);
	let clock = 0;
	const reaper = createChildReaper({ syscalls, now: () => clock, minWaitableMs: 5_000 });

	// When: the reaper ticks well past the window.
	reaper.tick();
	clock = 60_000;
	reaper.tick();

	// Then: nothing was reaped, and no call ever named the wildcard pid.
	expect(syscalls.reaped).toEqual([]);
	expect(syscalls.peeked).not.toContain(-1);
	expect(reaper.waitingPids).toEqual([]);
});

it("warns once per window while at least ten children stay waitable, naming the top three", () => {
	// Given: twelve orphans across three commands.
	const children = [
		...Array.from({ length: 6 }, (_, index) => ({ pid: 100 + index, name: "sleep", waitable: true })),
		...Array.from({ length: 4 }, (_, index) => ({ pid: 200 + index, name: "rg", waitable: true })),
		{ pid: 300, name: "git", waitable: true },
		{ pid: 301, name: "curl", waitable: true },
	];
	const logged: string[] = [];
	let clock = 0;
	const reaper = createChildReaper({
		syscalls: fakeSyscalls(children),
		now: () => clock,
		minWaitableMs: 5_000,
		log: (message) => logged.push(message),
	});

	// When: the reaper ticks twice inside the same warning window.
	reaper.tick();
	clock = 1_000;
	reaper.tick();

	// Then: exactly one warning, carrying the count and the three commonest names.
	expect(logged).toHaveLength(1);
	expect(logged[0]).toContain("12");
	expect(logged[0]).toContain("sleep");
	expect(logged[0]).toContain("rg");
	expect(logged[0]).not.toContain("curl");
});

it("stays off when SENPI_RPC_HOST_REAPER is 0 and defaults to a window above the 5 s floor", () => {
	// Given/When: the documented opt-out and the default.
	const disabled = resolveChildReaperConfig({ [CHILD_REAPER_ENV]: "0" });
	const enabled = resolveChildReaperConfig({});

	// Then: the opt-out disables it; the default window never dips under the floor.
	expect(disabled.enabled).toBe(false);
	expect(enabled.enabled).toBe(true);
	expect(enabled.minWaitableMs).toBeGreaterThanOrEqual(5_000);
	expect(enabled.tickMs).toBe(1_000);
});

it("does nothing but warn on a runtime without the syscalls", async () => {
	// Given: this suite runs under Node, which has no bun:ffi bindings.
	const logged: string[] = [];

	// When: the host arms the reaper.
	const stop = await startHostChildReaper((message) => logged.push(message));

	// Then: no bindings, one warning naming the runtime, and a stop that is safe to call.
	expect(await loadChildReaperSyscalls()).toBeUndefined();
	expect(logged).toHaveLength(1);
	expect(logged[0]).toContain("Node");
	expect(() => stop()).not.toThrow();
});

it("reaps the children a terminated worker orphaned, and leaves them when disabled", () => {
	// Given/When: real orphans under Bun, with the reaper enabled and disabled.
	const enabled = runOrphanReaperFixture({});
	const disabled = runOrphanReaperFixture({ [CHILD_REAPER_ENV]: "0" });

	// Then: the leak is real, the reaper clears it, and the opt-out restores the leak.
	expect(enabled.before).toBeGreaterThan(0);
	expect(enabled.after).toBe(0);
	expect(disabled.enabled).toBe(false);
	expect(disabled.after).toBe(disabled.before);
	expect(disabled.after).toBeGreaterThan(0);
}, 120_000);
