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
	readonly stateRetained: boolean;
	readonly childAlive: boolean;
	readonly interruptMs: number;
	readonly next: Result;
	readonly nextMs: number;
	readonly note: string | undefined;
};

const CHILD_EXIT_POLL_MS = 25;
const CHILD_EXIT_POLL_ROUNDS = 80;
const BLOCKED_WORKER_HOLD_SECONDS = 8;
const BLOCKED_WORKER_STOP_BUDGET_MS = 4_500;
const FRESH_WORKER_RUN_BUDGET_MS = 1_500;

const SPAWN_CHILD_CELL =
	'globalThis.childMarker = 1; const child = Bun.spawn(["sleep", "30"]); print("MARK=" + child.pid); await child.exited; return "exited"';
const SYNC_BLOCK_CELL = `globalThis.childMarker = 1; print("MARK=0"); await Bun.sleep(50); Bun.spawnSync(["sleep", "${BLOCKED_WORKER_HOLD_SECONDS}"]); return "unblocked"`;

function driverSource(cell: string): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "interrupt-bun", cwd: process.cwd(), parallelPoolWidth: 1 });',
		"const marker = Promise.withResolvers();",
		"const run = kernel.run({",
		'  cellId: "interrupt-target",',
		`  code: ${JSON.stringify(cell)},`,
		"  timeoutMs: 20_000,",
		"  onMessage: (message) => {",
		'    if (message.type !== "text") return;',
		"    const match = /MARK=(\\d+)/.exec(message.data);",
		"    if (match) marker.resolve(Number(match[1]));",
		"  },",
		"});",
		"const pid = await marker.promise;",
		"await Bun.sleep(150);",
		"const interruptStartedAt = performance.now();",
		'const handle = await kernel.interrupt("kill-child");',
		"const interruptMs = performance.now() - interruptStartedAt;",
		"const result = await run;",
		"const stateRetained = await handle.stateRetained;",
		"const isAlive = () => { if (pid === 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };",
		`for (let round = 0; round < ${CHILD_EXIT_POLL_ROUNDS} && isAlive(); round += 1) await Bun.sleep(${CHILD_EXIT_POLL_MS});`,
		"const childAlive = isAlive();",
		"if (childAlive) process.kill(pid);",
		"const nextStartedAt = performance.now();",
		'const next = await kernel.run({ cellId: "after-interrupt", code: "return globalThis.childMarker", timeoutMs: 5_000 });',
		"const nextMs = performance.now() - nextStartedAt;",
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ result, stateRetained, childAlive, interruptMs, next, nextMs, note: handle.note }), "utf8");',
	].join("\n");
}

async function runInterruptDriver(cell: string): Promise<DriverReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-interrupt-bun-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(cell), "utf8");
		const run = spawnSync("bun", [driverPath, reportPath], { encoding: "utf8", cwd: root, timeout: 60_000 });
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status}: ${run.stderr}`);
		return JSON.parse(await readFile(reportPath, "utf8"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe.skipIf(!bunAvailable)("JavaScript kernel under Bun interrupts a running cell", () => {
	it("Given a cell awaiting `Bun.spawn(...).exited` when interrupted then the child is killed and the worker state survives", async () => {
		const report = await runInterruptDriver(SPAWN_CHILD_CELL);

		expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
		expect(report.childAlive).toBe(false);
		expect(report.stateRetained).toBe(true);
		expect(report.next).toMatchObject({ ok: true, valueRepr: "1" });
	});

	it("Given a worker blocked in `Bun.spawnSync` when interrupted then the stop returns within its deadline and a fresh worker serves the next cell", async () => {
		const report = await runInterruptDriver(SYNC_BLOCK_CELL);

		expect(report.interruptMs).toBeLessThan(BLOCKED_WORKER_STOP_BUDGET_MS);
		expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
		expect(report.stateRetained).toBe(false);
		expect(report.note).toMatch(/synchronous/iu);
		expect(report.next).toMatchObject({ ok: true });
		expect(report.next).not.toHaveProperty("valueRepr");
		expect(report.nextMs).toBeLessThan(FRESH_WORKER_RUN_BUDGET_MS);
	});
});
