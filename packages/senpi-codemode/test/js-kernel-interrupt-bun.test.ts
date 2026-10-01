import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { JavaScriptInterruptBounds } from "../src/kernels/js/interrupt-bounds.ts";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

type Result = Extract<KernelToHostMessage, { type: "result" }>;

type DriverReport = {
	readonly result: Result;
	readonly stateRetained: boolean;
	readonly childAliveAtStop: boolean;
	readonly childAlive: boolean;
	readonly grandchildAlive: boolean;
	readonly next: Result;
	readonly nextText: string;
	readonly note: string | undefined;
};

// #2275: each case picks the stop path it is about through the kernel's bounds instead of
// racing the production 500 ms acknowledgement deadline against host load. Cooperative cases
// get bounds no loaded host reaches; blocked-worker cases get bounds a blocked worker always misses.
const COOPERATIVE_BOUNDS: JavaScriptInterruptBounds = { ackMs: 20_000, graceMs: 20_000, terminateDeadlineMs: 20_000 };
const BLOCKED_WORKER_BOUNDS: JavaScriptInterruptBounds = { ackMs: 50, graceMs: 50, terminateDeadlineMs: 100 };

// The exit poll waits on process state and ends as soon as the tree is gone; its bound is only a circuit breaker.
const CHILD_EXIT_POLL_MS = 25;
const CHILD_EXIT_POLL_ROUNDS = 400;
const BLOCKED_WORKER_HOLD_SECONDS = 8;
const DRIVER_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 120_000;

const SPAWN_CHILD_CELL =
	'globalThis.childMarker = 1; const child = Bun.spawn(["sleep", "30"]); print("MARK=" + child.pid); await child.exited; return "exited"';
// `print` posts synchronously, so MARK reaching the host means the worker is already inside
// `Bun.spawnSync`: the interrupt can only be read after the blocking call returns.
const SYNC_BLOCK_CELL = `globalThis.childMarker = 1; print("MARK=0"); Bun.spawnSync(["sleep", "${BLOCKED_WORKER_HOLD_SECONDS}"]); return "unblocked"`;
// #1697: the worker that owns this child is abandoned while blocked, so only
// the host can still retire the child it was told about.
const SPAWN_THEN_SYNC_BLOCK_CELL = `globalThis.childMarker = 1; const child = Bun.spawn(["sleep", "30"]); print("MARK=" + child.pid); Bun.spawnSync(["sleep", "${BLOCKED_WORKER_HOLD_SECONDS}"]); return "unblocked"`;
// The interrupted cell keeps awaiting a shell whose sleep grandchild would
// otherwise be reparented to init when only the shell is signalled.
const SPAWN_TREE_CELL = [
	"globalThis.childMarker = 1;",
	'const child = Bun.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], { stdout: "pipe" });',
	"const { value } = await child.stdout.getReader().read();",
	'print("MARK=" + child.pid + " GRAND=" + new TextDecoder().decode(value).trim());',
	'await child.exited; return "exited"',
].join(" ");

// #2453: the cell awaits a `Bun.$` command. The command writes its own pid (Bun exposes none) so
// the driver can report it and clean it up; the cell waits for that file, prints MARK, then awaits.
const SHELL_WAIT_CELL = [
	"globalThis.childMarker = 1;",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder belongs to the cell's own Bun.$ template
	"const shell = Bun.$`sh -c ${'echo $$ > shell.pid; exec sleep 30'}`.quiet();",
	'const waiting = shell.then(() => "exited");',
	'while (!(await Bun.file("shell.pid").exists()) || (await Bun.file("shell.pid").text()).trim() === "") await Bun.sleep(10);',
	'print("MARK=" + (await Bun.file("shell.pid").text()).trim());',
	"return await waiting;",
].join(" ");

// The cell holds a `Bun.$` read it has not awaited yet while it awaits a child the interrupt kills,
// so the interrupt rejects that read with no handler attached.
const DELAYED_SHELL_WAIT_CELL = [
	"globalThis.childMarker = 1;",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder belongs to the cell's own Bun.$ template
	"const text = Bun.$`sh -c ${'echo $$ > shell.pid; exec sleep 30'}`.text();",
	'const child = Bun.spawn(["sleep", "30"]);',
	'while (!(await Bun.file("shell.pid").exists()) || (await Bun.file("shell.pid").text()).trim() === "") await Bun.sleep(10);',
	'print("MARK=" + (await Bun.file("shell.pid").text()).trim());',
	"await child.exited;",
	"return await text;",
].join(" ");

// The released command (no `.quiet()`) prints only once the next cell creates `release`, so its
// output would land in that cell unless the interrupt turned the echo off. The loop is bounded so a
// failed run cannot leave the command behind.
const RELEASED_SHELL_OUTPUT_CELL = [
	"globalThis.childMarker = 1;",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder belongs to the cell's own Bun.$ template
	"globalThis.released = Bun.$`sh -c ${'i=0; while [ ! -e release ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; echo LATE_SHELL_OUTPUT'}`;",
	'const waiting = globalThis.released.then(() => "exited");',
	'print("MARK=0");',
	"return await waiting;",
].join(" ");
const RELEASED_SHELL_NEXT_CELL =
	'await Bun.write("release", ""); const late = await globalThis.released; return late.stdout.toString().trim()';

const DEFAULT_NEXT_CELL = "return globalThis.childMarker";

function driverSource(cell: string, bounds: JavaScriptInterruptBounds, nextCell: string): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		`const kernel = new JavaScriptKernel({ sessionId: "interrupt-bun", cwd: process.cwd(), parallelPoolWidth: 1, interruptBounds: ${JSON.stringify(bounds)} });`,
		"const marker = Promise.withResolvers();",
		"let grandchildPid = 0;",
		"const run = kernel.run({",
		'  cellId: "interrupt-target",',
		`  code: ${JSON.stringify(cell)},`,
		"  timeoutMs: 60_000,",
		"  onMessage: (message) => {",
		'    if (message.type !== "text") return;',
		"    const grand = /GRAND=(\\d+)/.exec(message.data);",
		"    if (grand) grandchildPid = Number(grand[1]);",
		"    const match = /MARK=(\\d+)/.exec(message.data);",
		"    if (match) marker.resolve(Number(match[1]));",
		"  },",
		"});",
		"const pid = await marker.promise;",
		'const handle = await kernel.interrupt("kill-child");',
		"const result = await run;",
		"const stateRetained = await handle.stateRetained;",
		// A zombie (defunct) child is terminated, awaiting reap by its owner; treat it as not running.
		'const isAlive = (target) => { if (target === 0) return false; try { process.kill(target, 0); } catch { return false; } const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(target)]).stdout.toString().trim(); return stat.length > 0 && !stat.startsWith("Z"); };',
		"const childAliveAtStop = isAlive(pid);",
		`for (let round = 0; round < ${CHILD_EXIT_POLL_ROUNDS} && (isAlive(pid) || isAlive(grandchildPid)); round += 1) await Bun.sleep(${CHILD_EXIT_POLL_MS});`,
		"const childAlive = isAlive(pid);",
		"const grandchildAlive = isAlive(grandchildPid);",
		'for (const target of [pid, grandchildPid]) { if (isAlive(target)) { try { process.kill(target, "SIGKILL"); } catch {} } }',
		"let nextText = '';",
		`const next = await kernel.run({ cellId: "after-interrupt", code: ${JSON.stringify(nextCell)}, timeoutMs: 60_000, onMessage: (message) => { if (message.type === "text") nextText += message.data; } });`,
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ result, stateRetained, childAliveAtStop, childAlive, grandchildAlive, next, nextText, note: handle.note }), "utf8");',
	].join("\n");
}

async function runInterruptDriver(
	cell: string,
	bounds: JavaScriptInterruptBounds,
	nextCell = DEFAULT_NEXT_CELL,
): Promise<DriverReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-interrupt-bun-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(cell, bounds, nextCell), "utf8");
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

describe.skipIf(!bunAvailable)("JavaScript kernel under Bun interrupts a running cell", () => {
	it(
		"Given a cell awaiting `Bun.spawn(...).exited` when interrupted then the child is killed and the worker state survives",
		async () => {
			const report = await runInterruptDriver(SPAWN_CHILD_CELL, COOPERATIVE_BOUNDS);

			expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
			expect(report.note).toBeUndefined();
			expect(report.childAlive).toBe(false);
			expect(report.stateRetained).toBe(true);
			expect(report.next).toMatchObject({ ok: true, valueRepr: "1" });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"Given a worker blocked in `Bun.spawnSync` when interrupted past its deadlines then the worker is abandoned and a fresh worker serves the next cell",
		async () => {
			const report = await runInterruptDriver(SYNC_BLOCK_CELL, BLOCKED_WORKER_BOUNDS);

			expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
			expect(report.stateRetained).toBe(false);
			expect(report.note).toMatch(/synchronous/iu);
			expect(report.note).toContain(`${BLOCKED_WORKER_BOUNDS.terminateDeadlineMs}ms`);
			expect(report.next).toMatchObject({ ok: true });
			expect(report.next).not.toHaveProperty("valueRepr");
		},
		TEST_TIMEOUT_MS,
	);

	// #1697: the abandoned worker's children were dropped with its references.
	it(
		"Given a worker abandoned in `Bun.spawnSync` after spawning a child when interrupted then the host retires that child",
		async () => {
			const report = await runInterruptDriver(SPAWN_THEN_SYNC_BLOCK_CELL, BLOCKED_WORKER_BOUNDS);

			expect(report.note).toMatch(/synchronous/iu);
			expect(report.stateRetained).toBe(false);
			// The blocked worker can never reap or kill it, so the child is gone at stop only if the host retired it.
			expect(report.childAliveAtStop).toBe(false);
			expect(report.childAlive).toBe(false);
			expect(report.next).toMatchObject({ ok: true });
			expect(report.next).not.toHaveProperty("valueRepr");
		},
		TEST_TIMEOUT_MS,
	);

	// #2453: a cell awaiting `Bun.$` never settled inside the grace window, so every stop restarted
	// the worker and lost its globals.
	it(
		"Given a cell awaiting a long `Bun.$` command when interrupted then the cell settles and the worker state survives",
		async () => {
			const report = await runInterruptDriver(SHELL_WAIT_CELL, COOPERATIVE_BOUNDS);

			expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
			expect(report.note).toBeUndefined();
			expect(report.stateRetained).toBe(true);
			// Only the cell's wait is released; Bun offers no way to stop the command itself.
			expect(report.childAliveAtStop).toBe(true);
			expect(report.next).toMatchObject({ ok: true, valueRepr: "1" });
		},
		TEST_TIMEOUT_MS,
	);

	// #2453 follow-up: the released read rejected with no handler yet, and the default
	// `--unhandled-rejections=throw` killed the worker before the cell reached its `await`.
	it(
		"Given a cell holding an unawaited `Bun.$` read while it awaits a child when interrupted then the worker survives and the cell meets the interruption at its own await",
		async () => {
			const report = await runInterruptDriver(DELAYED_SHELL_WAIT_CELL, COOPERATIVE_BOUNDS);

			expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
			expect(report.note).toBeUndefined();
			expect(report.stateRetained).toBe(true);
			expect(report.childAliveAtStop).toBe(true);
			expect(report.next).toMatchObject({ ok: true, valueRepr: "1" });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"Given a released `Bun.$` command without quiet that prints during the next cell when it settles then its output stays out of that cell",
		async () => {
			const report = await runInterruptDriver(
				RELEASED_SHELL_OUTPUT_CELL,
				COOPERATIVE_BOUNDS,
				RELEASED_SHELL_NEXT_CELL,
			);

			expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
			expect(report.stateRetained).toBe(true);
			// The command finished inside the next cell, and nothing it printed was echoed there.
			expect(report.next).toMatchObject({ ok: true, valueRepr: '"LATE_SHELL_OUTPUT"' });
			expect(report.nextText).not.toContain("LATE_SHELL_OUTPUT");
		},
		TEST_TIMEOUT_MS,
	);

	// #1697: interrupt signalled the tracked shell only, leaving its sleep to init.
	it(
		"Given a cell awaiting a shell that forked a grandchild when interrupted then the whole tree is gone",
		async () => {
			const report = await runInterruptDriver(SPAWN_TREE_CELL, COOPERATIVE_BOUNDS);

			expect(report.result).toMatchObject({ ok: false, error: { message: expect.stringContaining("kill-child") } });
			expect(report.note).toBeUndefined();
			expect(report.childAlive).toBe(false);
			expect(report.grandchildAlive).toBe(false);
			expect(report.stateRetained).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});
