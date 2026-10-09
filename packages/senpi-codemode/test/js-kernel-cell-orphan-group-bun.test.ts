import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const posix = process.platform !== "win32";

type OrphanReport = {
	readonly ok: boolean;
	readonly grandchildPid: number;
	readonly grandchildAliveAfterSettle: boolean;
	readonly agentAlive: boolean;
};

// The subshell backgrounds `sleep` and exits at once, so the grandchild is re-parented to init before the cell
// returns: a walk by parent pid can no longer find it, only its process group can (senpi#3020).
const ORPHANED_GRANDCHILD_CELL = (spawnLine: string): string =>
	[
		spawnLine,
		"const grandchildPid = Number((await output).trim());",
		"await exited;",
		'print("GRAND=" + grandchildPid);',
		'return "done"',
	].join(" ");

const BUN_SPAWN_CELL = ORPHANED_GRANDCHILD_CELL(
	'const child = Bun.spawn(["sh", "-c", "(sleep 30 >/dev/null 2>&1 & echo $!)"], { stdout: "pipe" }); const output = new Response(child.stdout).text(); const exited = child.exited;',
);
const NODE_SPAWN_CELL = ORPHANED_GRANDCHILD_CELL(
	[
		'import { spawn } from "node:child_process";',
		'const child = spawn("sh", ["-c", "(sleep 30 >/dev/null 2>&1 & echo $!)"]);',
		'const output = new Promise((resolve) => { let s = ""; child.stdout.on("data", (d) => { s += d; }); child.stdout.on("end", () => resolve(s)); });',
		'const exited = new Promise((resolve) => child.on("exit", resolve));',
	].join(" "),
);

const POLL_MS = 25;
const POLL_ROUNDS = 400;

function driverSource(cell: string): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "cell-orphan-group", cwd: process.cwd(), parallelPoolWidth: 1 });',
		"let grandchildPid = 0;",
		"const result = await kernel.run({",
		'  cellId: "cell-orphan-group",',
		`  code: ${JSON.stringify(cell)},`,
		"  timeoutMs: 60_000,",
		"  onMessage: (message) => {",
		'    if (message.type !== "text") return;',
		"    const match = /GRAND=(\\d+)/.exec(message.data);",
		"    if (match) grandchildPid = Number(match[1]);",
		"  },",
		"});",
		'const isAlive = (target) => { if (target <= 0) return false; try { process.kill(target, 0); } catch { return false; } const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(target)]).stdout.toString().trim(); return stat.length > 0 && !stat.startsWith("Z"); };',
		`for (let round = 0; round < ${POLL_ROUNDS} && isAlive(grandchildPid); round += 1) await Bun.sleep(${POLL_MS});`,
		"const grandchildAliveAfterSettle = isAlive(grandchildPid);",
		'if (grandchildAliveAfterSettle) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} }',
		"const agentAlive = isAlive(process.pid);",
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ ok: result.ok === true, grandchildPid, grandchildAliveAfterSettle, agentAlive }), "utf8");',
	].join("\n");
}

async function runOrphanDriver(cell: string): Promise<OrphanReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-cell-orphan-group-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(cell), "utf8");
		const run = spawnSync("bun", [driverPath, reportPath], { encoding: "utf8", cwd: root, timeout: 90_000 });
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status} ${run.signal ?? ""}: ${run.stderr}`);
		const report: OrphanReport = JSON.parse(await readFile(reportPath, "utf8"));
		return report;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe.skipIf(!bunAvailable || !posix)(
	"JavaScript kernel retires a cell's orphaned grandchildren through their process group (senpi#3020)",
	{ timeout: 120_000 },
	() => {
		it("Given a Bun.spawn child whose grandchild was re-parented to init when the cell settles then the grandchild is gone and the agent is alive", async () => {
			// when
			const report = await runOrphanDriver(BUN_SPAWN_CELL);

			// then
			expect(report.ok).toBe(true);
			expect(report.grandchildPid).toBeGreaterThan(0);
			expect(report.grandchildAliveAfterSettle).toBe(false);
			expect(report.agentAlive).toBe(true);
		});

		it("Given a node:child_process child whose grandchild was re-parented to init when the cell settles then the grandchild is gone and the agent is alive", async () => {
			// when
			const report = await runOrphanDriver(NODE_SPAWN_CELL);

			// then
			expect(report.ok).toBe(true);
			expect(report.grandchildPid).toBeGreaterThan(0);
			expect(report.grandchildAliveAfterSettle).toBe(false);
			expect(report.agentAlive).toBe(true);
		});
	},
);
