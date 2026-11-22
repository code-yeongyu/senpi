import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isHostCrash, readHostCrashRecords } from "../../../src/modes/rpc/host-crash-record.ts";
import { recordDrainOverdue, SupervisorDrain } from "../../../src/modes/rpc/host-lifecycle-drain.ts";
import { HANDOFF_GRACE_MS_ENV } from "../../../src/modes/rpc/host-lifecycle-policy.ts";

// senpi#7098. A drain that outlived its grace only asked the child to drain again: the predecessor of a handoff ran
// beside its successor for hours with nothing on record. Every grace period a drain is still running now appends a
// `rpc-host-drain-overdue` record to crashes.jsonl, which host alarms read, and still never ends a turn.

const dirs: string[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	process.env[HANDOFF_GRACE_MS_ENV] = "60000";
});
afterEach(async () => {
	vi.useRealTimers();
	delete process.env[HANDOFF_GRACE_MS_ENV];
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function runningChild(): ChildProcess {
	return { pid: undefined, exitCode: null, signalCode: null } as unknown as ChildProcess;
}

it("records an overdue drain once per grace period while the generation still drains", async () => {
	const daemonDir = await mkdtemp(join(tmpdir(), "senpi-7098-overdue-"));
	dirs.push(daemonDir);
	const drain = new SupervisorDrain(
		runningChild(),
		() => false,
		undefined,
		undefined,
		(drainingForMs) => recordDrainOverdue(daemonDir, "draining-generation", drainingForMs),
	);

	drain.drain();
	await vi.advanceTimersByTimeAsync(59_999);
	expect(readHostCrashRecords(daemonDir)).toEqual([]);

	await vi.advanceTimersByTimeAsync(1);
	await vi.advanceTimersByTimeAsync(60_000);
	drain.stop();

	const records = readHostCrashRecords(daemonDir);
	expect(records).toMatchObject([
		{ kind: "rpc-host-drain-overdue", generation: "draining-generation", drainingForMs: 60_000 },
		{ kind: "rpc-host-drain-overdue", generation: "draining-generation", drainingForMs: 120_000 },
	]);
	expect(records.some(isHostCrash)).toBe(false);
});

it("stops recording once the drained child has exited", async () => {
	const daemonDir = await mkdtemp(join(tmpdir(), "senpi-7098-overdue-exit-"));
	dirs.push(daemonDir);
	const child = { pid: undefined, exitCode: null, signalCode: null } as { exitCode: number | null };
	const drain = new SupervisorDrain(
		child as unknown as ChildProcess,
		() => false,
		undefined,
		undefined,
		(ms) => recordDrainOverdue(daemonDir, "draining-generation", ms),
	);

	drain.drain();
	child.exitCode = 0;
	await vi.advanceTimersByTimeAsync(120_000);

	expect(readHostCrashRecords(daemonDir)).toEqual([]);
});
