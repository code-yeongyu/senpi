import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

type Result = Extract<KernelToHostMessage, { type: "result" }>;

type DriverReport = {
	readonly result: Result;
	readonly pid: number;
	readonly aliveAfterSettle: boolean;
	readonly grandchildPid: number;
	readonly grandchildAliveAfterSettle: boolean;
	readonly probe: Result | null;
};

// The cell returns without awaiting the child, so at settle nothing else holds
// it: no later await, no interrupt, no timeout. This is the shape that left
// dev servers and watchers reparented to init.
const ABANDONED_CHILD_CELL = 'const child = Bun.spawn(["sleep", "30"]); print("MARK=" + child.pid); return "done"';
const DETACHED_CHILD_CELL =
	'const child = Bun.spawn(["sleep", "30"], { detached: true }); print("MARK=" + child.pid); return "done"';
const AWAITED_CHILD_CELL =
	'const child = Bun.spawn(["true"]); print("MARK=" + child.pid); await child.exited; return "done"';
// SIGTERM is ignored (the disposition survives `exec`), so only the SIGKILL
// escalation can end it. The cell returns only after the shell reports that the
// trap is installed, and keeps the handle so a later cell can read how it died.
const TERM_IGNORING_CHILD_CELL = [
	'const child = Bun.spawn(["sh", "-c", "trap \'\' TERM; echo ready; exec sleep 30"], { stdout: "pipe" });',
	"globalThis.termIgnoringChild = child;",
	"await child.stdout.getReader().read();",
	'print("MARK=" + child.pid); return "done"',
].join(" ");
const TERM_IGNORING_EXIT_SIGNAL_PROBE =
	"await globalThis.termIgnoringChild.exited; return globalThis.termIgnoringChild.signalCode";
// The shell forks `sleep` and reports its pid before the cell returns. Killing
// only the tracked shell would reparent the sleep to init: the grandchild is
// the process a cell leaves behind when it spawns through a shell.
const GRANDCHILD_CELL = [
	'const child = Bun.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], { stdout: "pipe" });',
	"const { value } = await child.stdout.getReader().read();",
	'print("MARK=" + child.pid + " GRAND=" + new TextDecoder().decode(value).trim());',
	'return "done"',
].join(" ");
// node:child_process is the other spawn surface a cell can reach; its children
// must follow the same settle rule as Bun.spawn, including the detached opt-out.
const NODE_CHILD_PROCESS_CELL =
	'import { spawn } from "node:child_process"; const child = spawn("sleep", ["30"]); print("MARK=" + child.pid); return "done"';
const NODE_CHILD_PROCESS_DETACHED_CELL =
	'import { spawn } from "node:child_process"; const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" }); child.unref(); print("MARK=" + child.pid); return "done"';

// The exit poll waits on process state and ends as soon as the tree is gone; its bound is only a circuit breaker.
const CHILD_EXIT_POLL_MS = 25;
const CHILD_EXIT_POLL_ROUNDS = 400;
const DRIVER_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 120_000;

function driverSource(cell: string, probe: string | null): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "cell-end-children", cwd: process.cwd(), parallelPoolWidth: 1 });',
		"let pid = 0;",
		"let grandchildPid = 0;",
		"const result = await kernel.run({",
		'  cellId: "cell-end-target",',
		`  code: ${JSON.stringify(cell)},`,
		"  timeoutMs: 60_000,",
		"  onMessage: (message) => {",
		'    if (message.type !== "text") return;',
		"    const match = /MARK=(\\d+)/.exec(message.data);",
		"    if (match) pid = Number(match[1]);",
		"    const grand = /GRAND=(\\d+)/.exec(message.data);",
		"    if (grand) grandchildPid = Number(grand[1]);",
		"  },",
		"});",
		// A zombie (defunct) child is terminated, awaiting reap by its owner; treat it as not running.
		'const isAlive = (target) => { if (target === 0) return false; try { process.kill(target, 0); } catch { return false; } const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(target)]).stdout.toString().trim(); return stat.length > 0 && !stat.startsWith("Z"); };',
		`for (let round = 0; round < ${CHILD_EXIT_POLL_ROUNDS} && (isAlive(pid) || isAlive(grandchildPid)); round += 1) await Bun.sleep(${CHILD_EXIT_POLL_MS});`,
		"const aliveAfterSettle = isAlive(pid);",
		"const grandchildAliveAfterSettle = isAlive(grandchildPid);",
		'for (const target of [pid, grandchildPid]) { if (isAlive(target)) { try { process.kill(target, "SIGKILL"); } catch {} } }',
		`const probe = ${probe === null ? "null" : `await kernel.run({ cellId: "after-settle", code: ${JSON.stringify(probe)}, timeoutMs: 60_000 })`};`,
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ result, pid, aliveAfterSettle, grandchildPid, grandchildAliveAfterSettle, probe }), "utf8");',
	].join("\n");
}

async function runCellEndDriver(cell: string, probe: string | null = null): Promise<DriverReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-cell-end-children-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(cell, probe), "utf8");
		const run = spawnSync("bun", [driverPath, reportPath], {
			encoding: "utf8",
			cwd: root,
			timeout: DRIVER_TIMEOUT_MS,
		});
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status}: ${run.stderr}`);
		return JSON.parse(await readFile(reportPath, "utf8"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe.skipIf(!bunAvailable)(
	"JavaScript kernel under Bun retires a cell's children at settle",
	{ timeout: TEST_TIMEOUT_MS },
	() => {
		it("Given a cell that returns without awaiting its child when the cell settles then the child is not left running", async () => {
			const report = await runCellEndDriver(ABANDONED_CHILD_CELL);

			expect(report.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(report.pid).toBeGreaterThan(0);
			expect(report.aliveAfterSettle).toBe(false);
		});

		// #2275: the SIGKILL escalation is proven by the exit signal the kernel's own handle recorded, not by settle time.
		it("Given a child that ignores SIGTERM when the cell settles then the SIGKILL escalation ends it", async () => {
			const report = await runCellEndDriver(TERM_IGNORING_CHILD_CELL, TERM_IGNORING_EXIT_SIGNAL_PROBE);

			expect(report.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(report.aliveAfterSettle).toBe(false);
			expect(report.probe).toMatchObject({ ok: true, valueRepr: '"SIGKILL"' });
		});

		it("Given a cell that spawned a detached child when the cell settles then the child is left running", async () => {
			// `detached: true` is the cell asking for a process that outlives it, so
			// cleanup must not treat it as abandoned.
			const report = await runCellEndDriver(DETACHED_CHILD_CELL);

			expect(report.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(report.aliveAfterSettle).toBe(true);
		});

		it("Given a cell that awaited its child when the cell settles then nothing is signalled and the value is unchanged", async () => {
			const report = await runCellEndDriver(AWAITED_CHILD_CELL);

			expect(report.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(report.aliveAfterSettle).toBe(false);
		});

		// #1697: killing only the tracked child reparented its descendants to init.
		it("Given a child that forked a grandchild when the cell settles then the whole tree is gone", async () => {
			const report = await runCellEndDriver(GRANDCHILD_CELL);

			expect(report.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(report.pid).toBeGreaterThan(0);
			expect(report.grandchildPid).toBeGreaterThan(0);
			expect(report.aliveAfterSettle).toBe(false);
			expect(report.grandchildAliveAfterSettle).toBe(false);
		});

		// #1697: node:child_process children were never tracked at all.
		it("Given a cell that spawned through node:child_process when the cell settles then the child is not left running", async () => {
			const report = await runCellEndDriver(NODE_CHILD_PROCESS_CELL);

			expect(report.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(report.pid).toBeGreaterThan(0);
			expect(report.aliveAfterSettle).toBe(false);
		});

		it("Given a detached node:child_process child when the cell settles then the child is left running", async () => {
			const report = await runCellEndDriver(NODE_CHILD_PROCESS_DETACHED_CELL);

			expect(report.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(report.aliveAfterSettle).toBe(true);
		});
	},
);
