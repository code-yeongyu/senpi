import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const reaperModulePath = fileURLToPath(new URL("../../coding-agent/src/modes/rpc/child-reaper.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const supportedPlatform = process.platform === "darwin" || process.platform === "linux";

type DriverReport = {
	readonly pid: number;
	/** `ps` state of the retired worker's child once the retirement returned: "" means no process-table entry. */
	readonly stateAfterRetire: string;
	readonly timedOut: boolean;
};

// The same shape that leaves two zombies per retirement on a real session: the cell spawns a child, then blocks in
// a synchronous call past its timeout, so the kernel retires the worker while the child is still running.
const RETIRED_WORKER_CELL = [
	'const child = Bun.spawn(["sleep", "30"]);',
	'print("MARK=" + child.pid);',
	"await Bun.sleep(20);",
	'Bun.spawnSync(["sleep", "4"]);',
	"1",
].join(" ");

function driverSource(collect: boolean): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		`import { collectOrphanedChildren } from ${JSON.stringify(reaperModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		`const kernel = new JavaScriptKernel({ sessionId: "orphan-collect", cwd: process.cwd(), parallelPoolWidth: 1${collect ? ", collectOrphanedChildren" : ""} });`,
		"let pid = 0;",
		"const result = await kernel.run({",
		'  cellId: "retire-target",',
		`  code: ${JSON.stringify(RETIRED_WORKER_CELL)},`,
		"  timeoutMs: 1_000,",
		"  onMessage: (message) => {",
		'    if (message.type !== "text") return;',
		"    const match = /MARK=(\\d+)/.exec(message.data);",
		"    if (match) pid = Number(match[1]);",
		"  },",
		"});",
		// The next cell runs on the replacement worker, so the retirement, including its child cleanup, is complete.
		'await kernel.run({ cellId: "after-retire", code: "2", timeoutMs: 20_000 });',
		'const stateAfterRetire = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();',
		'try { process.kill(pid, "SIGKILL"); } catch {}',
		'await writeFile(reportPath, JSON.stringify({ pid, timedOut: result.ok === false, stateAfterRetire }), "utf8");',
		"process.exit(0);",
	].join("\n");
}

async function runDriver(collect: boolean): Promise<DriverReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-orphan-collect-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(collect), "utf8");
		const run = spawnSync("bun", [driverPath, reportPath], { encoding: "utf8", cwd: root, timeout: 60_000 });
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status}: ${run.stderr}`);
		return JSON.parse(await readFile(reportPath, "utf8"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

// #1962: a retired worker's children were killed but never waited on, so each stayed a zombie of the host.
describe.skipIf(!bunAvailable || !supportedPlatform)("JavaScript kernel collects a retired worker's children", () => {
	it("Given a worker retired while it owned a running child when the retirement returns then the child is collected, not a zombie", async () => {
		const report = await runDriver(true);

		expect(report.pid).toBeGreaterThan(0);
		expect(report.timedOut).toBe(true);
		expect(report.stateAfterRetire, JSON.stringify(report)).toBe("");
	});

	it("Given no collector when a worker is retired then its killed child is left as a zombie of the host", async () => {
		const report = await runDriver(false);

		expect(report.timedOut).toBe(true);
		expect(report.stateAfterRetire, JSON.stringify(report)).toMatch(/^Z/);
	});
});
