import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

// Bun.$ ShellPromise exposes no pid/kill on Bun 1.4 (measured on 1.4.2), so shell-template
// children cannot be signaled; the contracts below cover the Bun.spawn path, which is the
// measured orphan source. The driver runs the kernel under bun so cells see Bun globals.

type DriverReport = {
	readonly resultOk: boolean;
	readonly pid: number;
	readonly aliveAfterSettle: boolean;
};

function driverSource(): string {
	return [
		'import { readFile, writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [mode, reportPath] = process.argv.slice(2);",
		"const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };",
		"const deadWithin = async (pid, ms) => {",
		"  const deadline = Date.now() + ms;",
		"  while (Date.now() < deadline) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 100)); }",
		"  return !alive(pid);",
		"};",
		'const kernel = new JavaScriptKernel({ sessionId: "child-lifecycle", cwd: process.cwd(), parallelPoolWidth: 1 });',
		"let pid = Number.NaN;",
		"let resultOk = false;",
		'if (mode === "interrupt") {',
		'  const pidPath = reportPath + ".pid";',
		'  const code = `import { writeFileSync } from "node:fs";',
		'const p = Bun.spawn(["sh", "-c", "trap \'\' TERM; sleep 60"]);',
		'writeFileSync("${PID_PATH}", String(p.pid));',
		'await new Promise(() => {})`.replace("${PID_PATH}", pidPath);',
		'  const run = kernel.run({ cellId: "int", code, timeoutMs: 30_000 }).catch(() => undefined);',
		"  const deadline = Date.now() + 15_000;",
		"  while (Date.now() < deadline) {",
		'    pid = await readFile(pidPath, "utf8").then((t) => Number(t.trim()), () => Number.NaN);',
		"    if (Number.isInteger(pid) && pid > 0) break;",
		"    await new Promise((r) => setTimeout(r, 50));",
		"  }",
		'  if (!Number.isInteger(pid) || pid <= 0) throw new Error("child never wrote its pid");',
		'  await kernel.interrupt("child lifecycle test");',
		"  await run;",
		"  resultOk = true;",
		"} else {",
		'  const code = mode === "term-proof"',
		'    ? \'const p = Bun.spawn(["sh", "-c", "trap \\\'\\\' TERM; sleep 60"]); return p.pid\'',
		'    : \'const p = Bun.spawn(["sleep", "60"]); return p.pid\';',
		'  const result = await kernel.run({ cellId: "settle", code, timeoutMs: 15_000 });',
		"  resultOk = result.ok === true;",
		"  pid = result.ok ? Number(result.valueRepr) : Number.NaN;",
		"}",
		"await kernel.close();",
		'if (!Number.isInteger(pid) || pid <= 0) throw new Error("no child pid in result");',
		"const dead = await deadWithin(pid, 6_000);",
		'await writeFile(reportPath, JSON.stringify({ resultOk, pid, aliveAfterSettle: !dead }), "utf8");',
	].join("\n");
}

async function runDriver(mode: "settle" | "term-proof" | "interrupt"): Promise<DriverReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-child-lifecycle-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(), "utf8");
		const run = spawnSync("bun", [driverPath, mode, reportPath], { encoding: "utf8", cwd: root, timeout: 90_000 });
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status}: ${run.stderr.slice(-800)}`);
		return JSON.parse(await readFile(reportPath, "utf8")) as DriverReport;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("eval cell child process lifecycle", () => {
	it.skipIf(!bunAvailable)(
		"kills a spawned child when the cell settles",
		async () => {
			const report = await runDriver("settle");
			expect(report.resultOk).toBe(true);
			expect(report.aliveAfterSettle, `child ${report.pid} survived cell settle`).toBe(false);
		},
		120_000,
	);

	it.skipIf(!bunAvailable)(
		"escalates to SIGKILL when a settled cell's child ignores SIGTERM",
		async () => {
			const report = await runDriver("term-proof");
			expect(report.resultOk).toBe(true);
			expect(report.aliveAfterSettle, `term-proof child ${report.pid} survived cell settle`).toBe(false);
		},
		120_000,
	);

	it.skipIf(!bunAvailable)(
		"escalates to SIGKILL for term-proof children on interrupt",
		async () => {
			const report = await runDriver("interrupt");
			expect(report.aliveAfterSettle, `term-proof child ${report.pid} survived interrupt`).toBe(false);
		},
		120_000,
	);
});
