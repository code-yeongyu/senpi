// senpi#3566 todo 6: the job policy against real tool children driven by the SENPI_TOOL_CHILD_TEST_* injection switches.
// Supervisor timers are a manual clock, so the cancel ladder and liveness fire exactly when the test advances them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolChildClient } from "./client.ts";
import type { SupervisorTimers } from "./job-supervisor.ts";
import { TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";
import { SessionToolChild } from "./session-child.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const command = { command: process.execPath, args: ["--import", resolver, roleEntry] };
const extensionDir = resolve(import.meta.dirname, "../../../../test/fixtures/module-job-ext");
const modulePath = join(extensionDir, "offload.ts");
const sleepJob = (ms: number) => ({ modulePath, export: "sleepFor", args: { ms } });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function manualClock() {
	let now = 0;
	const pending: Array<{ at: number; fn: () => void; live: boolean }> = [];
	const timers: SupervisorTimers = {
		set: (fn, ms) => {
			const entry = { at: now + ms, fn, live: true };
			pending.push(entry);
			return () => {
				entry.live = false;
			};
		},
	};
	const advance = (ms: number) => {
		const until = now + ms;
		for (;;) {
			const next = pending.filter((entry) => entry.live && entry.at <= until).sort((a, b) => a.at - b.at)[0];
			if (next === undefined) break;
			now = next.at;
			next.live = false;
			next.fn();
		}
		now = until;
	};
	return { timers, advance };
}

async function client(
	switches: Record<string, string>,
	extra: { timers?: SupervisorTimers; readyMs?: number; onCancelAck?: (jobId: string) => void } = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "tjs-"));
	const instance = new ToolChildClient({
		dir,
		cwd: dir,
		command,
		env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify([extensionDir]), ...switches },
		...extra,
	});
	cleanups.push(async () => {
		await instance.close().catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return instance;
}

async function sessionChild(switches: Record<string, string>, now: () => number = Date.now) {
	const dir = await mkdtemp(join(tmpdir(), "tjs-s-"));
	const child = new SessionToolChild({
		dir,
		cwd: dir,
		command,
		moduleRoots: () => [extensionDir],
		onRecord: () => {},
		env: { ...process.env, ...switches },
		now,
	});
	cleanups.push(async () => {
		await child.close().catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return child;
}

describe.skipIf(process.platform === "win32")("job policy injection switches", () => {
	it("IGNORE_CANCEL: the child keeps the job, TERM ends it exactly at 5 s", async () => {
		const clock = manualClock();
		const acks: string[] = [];
		const instance = await client(
			{ SENPI_TOOL_CHILD_TEST_IGNORE_CANCEL: "1" },
			{ timers: clock.timers, onCancelAck: (jobId) => acks.push(jobId) },
		);
		await instance.start();
		const abort = new AbortController();
		const job = instance.run("module", sleepJob(60_000), abort.signal);
		let outcome: unknown = "pending";
		const settled = job.catch((error: unknown) => error);
		void settled.then((value) => {
			outcome = value;
		});
		abort.abort();
		// Frames are ordered and a cancel is acknowledged from the child's message handler: once the pong is back, an
		// acknowledgement has either arrived or will never come.
		await instance.ping();
		expect(acks).toEqual([]);
		expect(outcome).toBe("pending");
		clock.advance(4_999);
		expect(instance.state).toBe("live");
		clock.advance(1);
		expect(await settled).toMatchObject({ code: "tool_child_exited" });
	}, 30_000);

	it("without IGNORE_CANCEL the child acknowledges the cancel and the ladder never fires", async () => {
		const clock = manualClock();
		const acks: string[] = [];
		const instance = await client({}, { timers: clock.timers, onCancelAck: (jobId) => acks.push(jobId) });
		await instance.start();
		const abort = new AbortController();
		const settled = instance.run("module", sleepJob(60_000), abort.signal).catch((error: unknown) => error);
		abort.abort();
		await instance.ping();
		expect(acks).toHaveLength(1);
		expect(await settled).toMatchObject({ code: "tool_child_cancelled" });
		clock.advance(10_000);
		expect(instance.state).toBe("live");
	}, 30_000);

	it("STOP_SELF: three missed pongs end the child with tool_child_unresponsive", async () => {
		const clock = manualClock();
		const instance = await client({ SENPI_TOOL_CHILD_TEST_STOP_SELF: "1" }, { timers: clock.timers });
		await instance.start();
		const settled = instance.run("module", sleepJob(60_000)).catch((error: unknown) => error);
		clock.advance(20_000);
		expect(await settled).toMatchObject({ code: "tool_child_unresponsive" });
	}, 30_000);

	it("HANG_BEFORE_READY and EXIT_ON_START fail the bootstrap with their reasons", async () => {
		const hanging = await client({ SENPI_TOOL_CHILD_TEST_HANG_BEFORE_READY: "1" }, { readyMs: 300 });
		await expect(hanging.start()).rejects.toThrow(/ready_timeout/);
		const exiting = await client({ SENPI_TOOL_CHILD_TEST_EXIT_ON_START: "1" });
		await expect(exiting.start()).rejects.toThrow(/exited_before_ready/);
	}, 30_000);

	it("EXIT_MID_JOB: a non-idempotent job fails once, an idempotent one is retried exactly once", async () => {
		const switches = { SENPI_TOOL_CHILD_TEST_EXIT_MID_JOB: "module" };
		const plain = await sessionChild(switches);
		await expect(plain.runner(sleepJob(10), undefined)).rejects.toMatchObject({ code: "tool_child_exited" });
		expect(plain.row()).toMatchObject({ generation: 1 });
		const retried = await sessionChild(switches);
		await expect(retried.runner({ ...sleepJob(10), idempotent: true }, undefined)).rejects.toMatchObject({
			code: "tool_child_exited",
		});
		expect(retried.row()).toMatchObject({ generation: 2 });
	}, 60_000);

	it("EXIT_ON_START three times within 5 s: the fourth call is refused without a spawn", async () => {
		const child = await sessionChild({ SENPI_TOOL_CHILD_TEST_EXIT_ON_START: "1" }, () => 0);
		for (let attempt = 0; attempt < 3; attempt++)
			await expect(child.runner(sleepJob(10), undefined)).rejects.toThrow(/exited_before_ready/);
		await expect(child.runner(sleepJob(10), undefined)).rejects.toMatchObject({ code: "tool_child_unavailable" });
	}, 60_000);
});
