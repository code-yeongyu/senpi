import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const posix = process.platform !== "win32";

type GroupReport = {
	readonly ok: boolean;
	readonly agentPgid: number;
	readonly childPgid: number;
	readonly jobPgid: number;
	readonly jobAliveAfterGroupKill: boolean;
	readonly stderr: string;
	readonly promisified?: boolean;
};

// The cell starts a background job through a shell (the `nohup ... &` shape from senpi#2995), reads the process
// groups with `ps`, and signals the job's group only when it is not the agent's own, so a regression fails the
// assertion instead of stopping the test runner.
function groupCell(spawnLine: string): string {
	return [
		spawnLine,
		"const { value } = await stdout.getReader().read(); const jobPid = Number(new TextDecoder().decode(value).trim().split(/\\s+/)[0]);",
		'const pgidOf = (pid) => Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim());',
		"const agentPgid = pgidOf(process.pid); const childPgid = pgidOf(childPid); const jobPgid = pgidOf(jobPid);",
		"let jobAliveAfterGroupKill = true;",
		"if (childPgid > 0 && childPgid !== agentPgid) {",
		'  process.kill(-childPgid, "SIGTERM");',
		'  for (let round = 0; round < 400; round += 1) { try { process.kill(jobPid, 0); } catch { jobAliveAfterGroupKill = false; break; } const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(jobPid)]).stdout.toString().trim(); if (stat === "" || stat.startsWith("Z")) { jobAliveAfterGroupKill = false; break; } await Bun.sleep(25); }',
		'} else { try { process.kill(jobPid, "SIGKILL"); } catch {} }',
		'print("REPORT=" + JSON.stringify({ agentPgid, childPgid, jobPgid, jobAliveAfterGroupKill }));',
		'return "done"',
	].join("\n");
}

const BUN_SPAWN_CELL = groupCell(
	'const child = Bun.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], { stdout: "pipe" }); const childPid = child.pid; const stdout = child.stdout;',
);
const NODE_SPAWN_CELL = groupCell(
	[
		'import { spawn } from "node:child_process";',
		'const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"]); const childPid = child.pid;',
		'const stdout = new ReadableStream({ start(controller) { child.stdout.once("data", (data) => { controller.enqueue(data); controller.close(); }); } });',
	].join(" "),
);

// Signal 0 to a group that does not exist only checks for it, so nothing is signalled; the notice is what the cell must see.
const SHELL_GROUP_KILL_TEXT_CELL =
	'await Bun.$`kill -0 -- -999999 2>/dev/null; true`.quiet(); print("REPORT=" + JSON.stringify({ agentPgid: 0, childPgid: 0, jobPgid: 0, jobAliveAfterGroupKill: false })); return "done"';

// promisify(exec) must still resolve to { stdout, stderr } through the worker's wrapped child_process.
const PROMISIFIED_EXEC_CELL = [
	'import { exec } from "node:child_process"; import { promisify } from "node:util";',
	'const result = await promisify(exec)("echo hi; kill -0 -- -999999 2>/dev/null; true");',
	'print("REPORT=" + JSON.stringify({ agentPgid: 0, childPgid: 0, jobPgid: 0, jobAliveAfterGroupKill: false, promisified: typeof result === "object" && result !== null && String(result.stdout).trim() === "hi" }));',
	'return "done"',
].join(" ");

function driverSource(cell: string): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "cell-process-group", cwd: process.cwd(), parallelPoolWidth: 1 });',
		"let report = null;",
		'let stderr = "";',
		"const result = await kernel.run({",
		'  cellId: "cell-process-group",',
		`  code: ${JSON.stringify(cell)},`,
		"  timeoutMs: 60_000,",
		"  onMessage: (message) => {",
		'    if (message.type !== "text") return;',
		'    if (message.stream === "stderr") stderr += message.data;',
		"    const match = /REPORT=(\\{.*\\})/.exec(message.data);",
		"    if (match) report = JSON.parse(match[1]);",
		"  },",
		"});",
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ ok: result.ok === true, stderr, ...report }), "utf8");',
	].join("\n");
}

async function runGroupDriver(cell: string): Promise<GroupReport> {
	const root = await mkdtemp(join(tmpdir(), "senpi-cell-process-group-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(cell), "utf8");
		const run = spawnSync("bun", [driverPath, reportPath], { encoding: "utf8", cwd: root, timeout: 90_000 });
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status} ${run.signal ?? ""}: ${run.stderr}`);
		return JSON.parse(await readFile(reportPath, "utf8"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe.skipIf(!bunAvailable || !posix)(
	"JavaScript kernel children start their own process group (senpi#2995)",
	{ timeout: 120_000 },
	() => {
		it("Given a Bun.spawn background job when the cell signals the job's process group then the agent is not in it and the job is gone", async () => {
			// when
			const report = await runGroupDriver(BUN_SPAWN_CELL);

			// then
			expect(report.ok).toBe(true);
			expect(report.childPgid).not.toBe(report.agentPgid);
			expect(report.jobPgid).toBe(report.childPgid);
			expect(report.jobAliveAfterGroupKill).toBe(false);
		});

		it("Given a node:child_process background job when the cell signals the job's process group then the agent is not in it and the job is gone", async () => {
			// when
			const report = await runGroupDriver(NODE_SPAWN_CELL);

			// then
			expect(report.ok).toBe(true);
			expect(report.childPgid).not.toBe(report.agentPgid);
			expect(report.jobPgid).toBe(report.childPgid);
			expect(report.jobAliveAfterGroupKill).toBe(false);
		});

		it("Given a Bun.$ command that signals a process group when it runs then the cell gets the shared-group notice", async () => {
			// when
			const report = await runGroupDriver(SHELL_GROUP_KILL_TEXT_CELL);

			// then
			expect(report.ok).toBe(true);
			expect(report.stderr).toContain("[senpi:group-signal]");
		});

		it("Given a cell that promisifies child_process.exec when it runs then the result keeps stdout and stderr and the group-signal notice still fires", async () => {
			// when
			const report = await runGroupDriver(PROMISIFIED_EXEC_CELL);

			// then
			expect(report.ok).toBe(true);
			expect(report.promisified).toBe(true);
			expect(report.stderr).toContain("[senpi:group-signal]");
		});
	},
);
