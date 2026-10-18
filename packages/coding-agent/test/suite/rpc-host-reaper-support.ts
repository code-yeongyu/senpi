import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ChildReaperSyscalls } from "../../src/modes/rpc/child-reaper-syscalls.ts";

const reaperModule = fileURLToPath(new URL("../../src/modes/rpc/child-reaper.ts", import.meta.url));
const syscallsModule = fileURLToPath(new URL("../../src/modes/rpc/child-reaper-syscalls.ts", import.meta.url));

/** Z-state children of one pid: macOS exposes them through `ps`, Linux through /proc. */
export function zombieChildCount(pid: number): number {
	if (process.platform === "linux") {
		return readdirSync("/proc").filter((entry) => {
			const stat = procStat(Number(entry));
			const fields = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
			return fields !== undefined && fields[0] === "Z" && Number(fields[1]) === pid;
		}).length;
	}
	return execFileSync("ps", ["-axo", "ppid=,stat="], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([parent, state]) => Number(parent) === pid && state?.startsWith("Z")).length;
}

function procStat(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
}

/** Records every kernel call so a test can prove `waitpid(-1)` is never reachable. */
export interface RecordingSyscalls extends ChildReaperSyscalls {
	readonly peeked: number[];
	readonly reaped: number[];
}

export interface FakeChild {
	readonly pid: number;
	readonly name: string;
	waitable: boolean;
}

/** In-memory process table: the same contract as the real bindings, no kernel. */
export function fakeSyscalls(children: FakeChild[]): RecordingSyscalls {
	const peeked: number[] = [];
	const reaped: number[] = [];
	return {
		peeked,
		reaped,
		listDirectChildren: () => children.map((child) => child.pid),
		isWaitable(pid) {
			peeked.push(pid);
			return children.find((child) => child.pid === pid)?.waitable === true;
		},
		reapExited(pid) {
			reaped.push(pid);
			const index = children.findIndex((child) => child.pid === pid);
			if (index === -1 || !children[index]?.waitable) return false;
			children.splice(index, 1);
			return true;
		},
		describe: (pid) => children.find((child) => child.pid === pid)?.name ?? "",
	};
}

const fixtureResultSchema = z.object({ before: z.number(), after: z.number(), enabled: z.boolean() });

/**
 * Runs the real reaper against real orphans under Bun: a worker spawns children,
 * the worker is terminated (the `session-worker-client.ts` quarantine shape), and
 * the resulting zombies are counted before and after the reaper's two ticks.
 *
 * Time is faked inside the fixture, so the run costs no wall clock beyond the
 * children's own exit.
 */
export function runOrphanReaperFixture(env: Readonly<Record<string, string>>, orphans = 8) {
	const directory = mkdtempSync(join(tmpdir(), "dh-reap-"));
	const fixture = join(directory, "orphan-fixture.mjs");
	writeFileSync(fixture, fixtureSource(orphans));
	try {
		const output = execFileSync("bun", [fixture], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, ...env },
		});
		return fixtureResultSchema.parse(JSON.parse(output.trim().split("\n").at(-1) ?? "{}"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function fixtureSource(orphans: number): string {
	return `
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { createChildReaper, resolveChildReaperConfig } from ${JSON.stringify(reaperModule)};
import { loadChildReaperSyscalls } from ${JSON.stringify(syscallsModule)};

if (!isMainThread) {
	for (let index = 0; index < ${orphans}; index++) spawn("/bin/sh", ["-c", "sleep 0.2"], { stdio: "ignore" });
	parentPort.postMessage("spawned");
	await new Promise(() => {});
}

const worker = new Worker(new URL(import.meta.url));
await new Promise((resolve) => worker.once("message", resolve));
await worker.terminate();

const syscalls = await loadChildReaperSyscalls();
const waitable = () => syscalls.listDirectChildren().filter((pid) => syscalls.isWaitable(pid)).length;
const deadline = Date.now() + 20_000;
while (waitable() < ${orphans} && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

const before = waitable();
const config = resolveChildReaperConfig(process.env);
if (config.enabled) {
	let clock = 0;
	const reaper = createChildReaper({ syscalls, now: () => clock, minWaitableMs: config.minWaitableMs });
	reaper.tick();
	clock += config.minWaitableMs + 1;
	reaper.tick();
}
console.log(JSON.stringify({ before, after: waitable(), enabled: config.enabled }));
process.exit(0);
`;
}
