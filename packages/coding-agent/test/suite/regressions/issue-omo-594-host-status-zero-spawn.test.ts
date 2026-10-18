import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Fixes code-yeongyu/omo-desktop-app#594.
 *
 * The production omo RPC host (`--mode rpc --multi-session --listen unix://...`) accumulated
 * <defunct> children at client-driven cadence (~1.7 zombies/min measured, 0 live children,
 * monotonic). The class is a long-lived host spawning a short-lived probe process per request:
 * on a runtime whose `execFile` does not reap, every probe becomes a permanent zombie of the
 * host. Senpi #1507 removed the last such probe from the watchdog; the status surface
 * (`readHostProcessMetrics` -> `ps -A` per `host status` / generations read, added later)
 * reintroduced the same shape at poll cadence.
 *
 * The contract here is the one #1721 established for the watchdog: the host-path status read
 * spawns ZERO children. The child process table is read through the kernel instead, so there is
 * nothing that can become a zombie.
 *
 * RED faithfully reproduces the production runtime condition: `execFile` is replaced with one
 * whose probe children are real but carry no exit watcher (spawned inside a worker thread that
 * is then terminated - the exact orphaning the reaper's own matrix measured). On the unmodified
 * tree every metrics read leaves one real zombie under this process; after the fix nothing
 * spawns at all, so the zombie count returns to (and stays at) 0.
 */
const brokenRuntime = vi.hoisted(() => ({
	execFileCalls: 0,
	spawnedOrphans: 0,
	acks: 0,
	directory: "",
	terminateWorker: undefined as undefined | (() => Promise<void>),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	// Hoisted above the file's imports, so the factory resolves everything it touches.
	const { Worker } = await import("node:worker_threads");
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	// One shared worker owns every probe child, exactly like the runtime's own process would;
	// terminating it destroys each child's exit watcher with the thread that spawned it.
	const directory = mkdtempSync(join(tmpdir(), "omo-594-worker-"));
	brokenRuntime.directory = directory;
	writeFileSync(
		join(directory, "probe-children.mjs"),
		[
			'import { parentPort, isMainThread } from "node:worker_threads";',
			'import { spawn } from "node:child_process";',
			"if (!isMainThread) {",
			'	parentPort.on("message", () => {',
			'		spawn("/bin/sleep", ["0.4"], { stdio: "ignore" });',
			'		parentPort.postMessage("spawned");',
			"	});",
			"}",
			"await new Promise(() => {});",
		].join("\n"),
	);
	let worker: import("node:worker_threads").Worker | undefined;
	const ownedWorker = () => {
		if (worker === undefined) {
			worker = new Worker(join(directory, "probe-children.mjs"));
			worker.on("message", (message: unknown) => {
				if (message === "spawned") brokenRuntime.acks += 1;
			});
		}
		return worker;
	};

	/** A ps-shaped table naming only this process, so the unmodified parser walks a one-row tree. */
	const cannedTable = () => `${process.pid} ${process.ppid} S 4096\n`;

	const brokenExecFile = (
		_command: string,
		_args: readonly string[],
		_options: unknown,
		callback: (error: null, stdout: string, stderr: string) => void,
	) => {
		brokenRuntime.execFileCalls += 1;
		brokenRuntime.spawnedOrphans += 1;
		ownedWorker().postMessage("spawn");
		callback(null, cannedTable(), "");
	};

	brokenRuntime.terminateWorker = async () => {
		if (worker === undefined) return;
		const deadline = Date.now() + 10_000;
		while (brokenRuntime.acks < brokenRuntime.spawnedOrphans && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await worker.terminate();
	};

	return { ...actual, execFile: brokenExecFile };
});

import { readHostProcessMetrics } from "../../../src/modes/rpc/host-process-metrics.ts";
import { parseKernelProcessTable } from "../../../src/modes/rpc/host-process-table.ts";
import { zombieChildCount } from "../rpc-host-reaper-support.ts";

/** Status reads per test: a desktop client polls the daemon status well within this cadence. */
const STATUS_READS = 30;
/** Bounded wait for the probe children to become observable zombies; ends on the observation. */
const SETTLE_DEADLINE_MS = 15_000;

/** The pinned darwin arm64 `kinfo_proc` layout, written independently of the reader's constants. */
const KINFO_STRIDE = 648;
const KINFO_PID = 40;
const KINFO_PPID = 560;
const KINFO_STAT = 36;
/** Any p_stat other than SZOMB (5) stands in for a live process. */
const LIVE_STAT = 2;
const SZOMB_STAT = 5;

interface SyntheticKernelRow {
	readonly pid: number;
	readonly ppid: number;
	readonly stat: number;
}

/** Builds a raw sysctl-shaped buffer; a wrong stride or ppid offset simulates layout drift. */
function syntheticKernelTable(
	rows: readonly SyntheticKernelRow[],
	layout: { stride?: number; ppidOffset?: number } = {},
): Uint8Array {
	const stride = layout.stride ?? KINFO_STRIDE;
	const ppidOffset = layout.ppidOffset ?? KINFO_PPID;
	const table = new Uint8Array(rows.length * stride);
	const view = new DataView(table.buffer);
	rows.forEach((row, index) => {
		view.setUint32(index * stride + KINFO_PID, row.pid, true);
		if (index * stride + ppidOffset + 4 <= table.byteLength) {
			view.setUint32(index * stride + ppidOffset, row.ppid, true);
		}
		table[index * stride + KINFO_STAT] = row.stat;
	});
	return table;
}

async function settledZombieCount(): Promise<number> {
	const deadline = Date.now() + SETTLE_DEADLINE_MS;
	let count = zombieChildCount(process.pid);
	while (count > 0 && count < STATUS_READS && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		count = zombieChildCount(process.pid);
	}
	return count;
}

describe("rpc host status reads (omo-desktop#594)", () => {
	it(`drives ${STATUS_READS} status reads through the host metrics path and leaves zero zombies`, async () => {
		// When: the client polls daemon status, each read asking the host for its process metrics.
		for (let read = 0; read < STATUS_READS; read++) {
			await readHostProcessMetrics(process.pid);
		}
		// Every probe child the broken runtime spawned is terminated with its owning thread.
		await brokenRuntime.terminateWorker?.();

		// Then: no exited-but-unclaimed child remains under the host pid.
		expect(await settledZombieCount()).toBe(0);
		// And the read itself never spawned a probe process.
		expect(brokenRuntime.execFileCalls).toBe(0);
	}, 60_000);

	afterAll(() => {
		if (brokenRuntime.directory !== "") rmSync(brokenRuntime.directory, { recursive: true, force: true });
	});

	it("reports the host process metrics from the kernel table without any probe spawn (bun)", async () => {
		// A bun-run fixture exercises the real reader end to end: rss for the daemon tree is
		// observable, real orphans under the host are COUNTED, and once reaped the count
		// returns to 0 - the observability `ps` used to provide, with zero children spawned.
		const result = runStatusMetricsFixture();
		expect(result.reads).toBe(6);
		expect(result.zombiesBeforeReap).toBe(8);
		expect(result.zombiesAfterReap).toBe(0);
		// The tiny-buffer run forced the first sysctl to overflow; the reader still answered.
		expect(result.overflowRecovered).toBe(true);
	}, 120_000);

	it("parses a kinfo_proc table at the pinned offsets and fails closed on layout drift", () => {
		const resident = (pid: number) => (pid === process.pid ? 4096 : 8192);

		// Positive: this process, one live child, one zombie child - all at the pinned offsets.
		const pinned = syntheticKernelTable([
			{ pid: process.pid, ppid: process.ppid, stat: LIVE_STAT },
			{ pid: 4242, ppid: process.pid, stat: LIVE_STAT },
			{ pid: 4243, ppid: process.pid, stat: SZOMB_STAT },
		]);
		const rows = parseKernelProcessTable(pinned, 3, resident);
		expect(rows?.find((row) => row.pid === process.pid)?.ppid).toBe(process.ppid);
		expect(rows?.filter((row) => row.state === "Z").map((row) => row.pid)).toEqual([4243]);

		// Wrong ppid offset: the self row's ppid no longer matches the kernel's view.
		const shiftedPpid = syntheticKernelTable([{ pid: process.pid, ppid: process.ppid, stat: LIVE_STAT }], {
			ppidOffset: 564,
		});
		expect(parseKernelProcessTable(shiftedPpid, 1, resident)).toBeUndefined();

		// Wrong stride: the kernel writes rows at a 600-byte spacing, so the self row's pid
		// (at 600+40) never lands on any 648-aligned pid slot and the self-check finds nothing.
		const wrongStride = syntheticKernelTable(
			[
				{ pid: 901, ppid: 1, stat: LIVE_STAT },
				{ pid: process.pid, ppid: process.ppid, stat: LIVE_STAT },
				{ pid: 903, ppid: 1, stat: LIVE_STAT },
				{ pid: 904, ppid: 1, stat: LIVE_STAT },
				{ pid: 905, ppid: 1, stat: LIVE_STAT },
				{ pid: 906, ppid: 1, stat: LIVE_STAT },
				{ pid: 907, ppid: 1, stat: LIVE_STAT },
			],
			{ stride: 600 },
		);
		expect(parseKernelProcessTable(wrongStride, 6, resident)).toBeUndefined();

		// A table that calls this live process a zombie describes a layout we do not trust.
		const zombieSelf = syntheticKernelTable([{ pid: process.pid, ppid: process.ppid, stat: SZOMB_STAT }]);
		expect(parseKernelProcessTable(zombieSelf, 1, resident)).toBeUndefined();

		// No self row at all: the buffer is not a table describing this process.
		const foreignOnly = syntheticKernelTable([{ pid: 999, ppid: 1, stat: LIVE_STAT }]);
		expect(parseKernelProcessTable(foreignOnly, 1, resident)).toBeUndefined();
	});
});

const metricsModule = fileURLToPath(new URL("../../../src/modes/rpc/host-process-metrics.ts", import.meta.url));
const tableModule = fileURLToPath(new URL("../../../src/modes/rpc/host-process-table.ts", import.meta.url));
const syscallsModule = fileURLToPath(new URL("../../../src/modes/rpc/child-reaper-syscalls.ts", import.meta.url));
const reaperModule = fileURLToPath(new URL("../../../src/modes/rpc/child-reaper.ts", import.meta.url));

const fixtureResultSchema = z.object({
	reads: z.number(),
	zombiesBeforeReap: z.number(),
	zombiesAfterReap: z.number(),
	overflowRecovered: z.boolean(),
});

function runStatusMetricsFixture() {
	const directory = mkdtempSync(join(tmpdir(), "omo-594-fixture-"));
	const fixture = join(directory, "status-metrics-fixture.mjs");
	writeFileSync(fixture, fixtureSource());
	try {
		const output = execFileSync("bun", [fixture], {
			encoding: "utf8",
			timeout: 90_000,
			env: {
				...process.env,
				// The reaper's abandonment window, floored at its 5 s minimum, keeps the
				// fixture's faked-clock ticks honest without a wall-clock wait.
				SENPI_RPC_HOST_REAPER_MIN_WAITABLE_MS: "5000",
			},
		});
		return fixtureResultSchema.parse(JSON.parse(output.trim().split("\n").at(-1) ?? "{}"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function fixtureSource(): string {
	return `
import { parentPort, isMainThread, Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { readHostProcessMetrics } from ${JSON.stringify(metricsModule)};
import { loadProcessTableReader } from ${JSON.stringify(tableModule)};
import { loadChildReaperSyscalls } from ${JSON.stringify(syscallsModule)};
import { createChildReaper, resolveChildReaperConfig } from ${JSON.stringify(reaperModule)};

// Real orphans under this process: a terminated worker's children, the shape the reaper owns.
if (!isMainThread) {
	for (let index = 0; index < 8; index++) spawn("/bin/sleep", ["0.2"], { stdio: "ignore" });
	parentPort.postMessage("spawned");
	await new Promise(() => {});
}

// Six status reads through the real metrics path: the desktop poll cadence.
let reads = 0;
for (let index = 0; index < 6; index++) {
	const metrics = await readHostProcessMetrics(process.pid);
	if (metrics.rss_mb === null || metrics.zombies === null) {
		console.error("metrics unreadable under bun: kernel table reader unavailable");
		process.exit(3);
	}
	reads += 1;
}

const worker = new Worker(new URL(import.meta.url));
await new Promise((resolve) => worker.once("message", resolve));
await worker.terminate();

const syscalls = await loadChildReaperSyscalls();
const waitable = () => syscalls.listDirectChildren().filter((pid) => syscalls.isWaitable(pid)).length;
const deadline = Date.now() + 20_000;
while (waitable() < 8 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

const zombiesBeforeReap = (await readHostProcessMetrics(process.pid)).zombies;

const config = resolveChildReaperConfig(process.env);
let clock = 0;
const reaper = createChildReaper({ syscalls, now: () => clock, minWaitableMs: config.minWaitableMs });
reaper.tick();
clock += config.minWaitableMs + 1;
reaper.tick();

let zombiesAfterReap = (await readHostProcessMetrics(process.pid)).zombies;
while (zombiesAfterReap > 0 && Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 20));
	zombiesAfterReap = (await readHostProcessMetrics(process.pid)).zombies;
}

// Force the sysctl growth path: a 512-byte start buffer cannot hold the table, so the
// first call overflows and the reader must grow geometrically and still answer - with the
// fail-closed self row intact.
const tiny = await loadProcessTableReader(process.platform, { initialTableBytes: 512 });
const tinyRows = tiny?.();
const tinySelf = tinyRows?.find((row) => row.pid === process.pid);
const overflowRecovered =
	tinyRows !== undefined && (tinyRows?.length ?? 0) > 0 && tinySelf?.ppid === process.ppid && tinySelf.state !== "Z";

console.log(JSON.stringify({ reads, zombiesBeforeReap, zombiesAfterReap, overflowRecovered }));
process.exit(0);
`;
}
