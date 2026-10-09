import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const subprocessModulePath = fileURLToPath(new URL("../src/kernels/shared/subprocess-process.ts", import.meta.url));
const pythonTransportModulePath = fileURLToPath(new URL("../src/kernels/py/transport.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const posix = process.platform !== "win32";

type EpipeReport = { readonly errors: readonly string[]; readonly sendAfterExit: boolean };
type PythonEpipeReport = { readonly startFailed: string; readonly errors: readonly string[] };

// The child closes its stdin, says "ready" and stays alive, so the host's next frame write hits a pipe with no reader
// (EPIPE) without any race on the child's exit. A second process then exits before a frame is sent to it. An
// unhandled stream error would end the driver with a non-zero status before it writes its report (senpi#3016).
function driverSource(): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { SubprocessProcess, spawnSubprocess } from ${JSON.stringify(subprocessModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		"const errors = [];",
		"let ready = () => {};",
		"const readyLine = new Promise((resolve) => { ready = resolve; });",
		"let reported = () => {};",
		"const errorReported = new Promise((resolve) => { reported = resolve; });",
		"const handlers = {",
		'  onLine: (_source, line) => { if (line.trim() === "ready") ready(); },',
		"  onStderr: () => {},",
		"  onExit: () => {},",
		"  onError: (_source, error) => { errors.push(String(error.code ?? error.message)); reported(); },",
		"};",
		'const closed = new SubprocessProcess(spawnSubprocess(undefined, { command: "sh", args: ["-c", "exec 0</dev/null; echo ready; sleep 5"] }), handlers);',
		"await readyLine;",
		'closed.send("x".repeat(256 * 1024) + "\\n");',
		"await Promise.race([errorReported, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);",
		"await closed.terminate();",
		'const exited = new SubprocessProcess(spawnSubprocess(undefined, { command: "sh", args: ["-c", "exit 0"] }), handlers);',
		"await exited.terminate();",
		'const sendAfterExit = exited.send("frame\\n");',
		"await new Promise((resolve) => setImmediate(resolve));",
		'await writeFile(reportPath, JSON.stringify({ errors, sendAfterExit }), "utf8");',
	].join("\n");
}

// The Python transport writes its init frame to the interpreter's stdin at once. A real pipe only fails once the reader
// has closed, which races that first write, so this child's stdin fails every write with EPIPE the way a dead pipe
// does: asynchronously, as an "error" event on the stream. Start must fail with that error, not crash the host.
function pythonDriverSource(): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { PythonKernelTransport } from ${JSON.stringify(pythonTransportModulePath)};`,
		'import { EventEmitter } from "node:events";',
		'import { PassThrough, Writable } from "node:stream";',
		'const brokenPipeChild = () => { const child = new EventEmitter(); child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); } }); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false; child.kill = () => true; return child; };',
		"const [reportPath] = process.argv.slice(2);",
		"const errors = [];",
		'let startFailed = "";',
		"try {",
		"  await PythonKernelTransport.start({",
		'    interpreterPath: "python3", sessionId: "stdin-epipe", cwd: process.cwd(),',
		'    connection: { url: "http://127.0.0.1:9", token: "t" },',
		"    startupTimeoutMs: 5_000, startupCeilingMs: 5_000,",
		"    spawnProcess: () => brokenPipeChild(),",
		"    isOwned: () => true, onRetirementFailure: () => {}, onResult: () => {},",
		"    onError: (_t, error) => { errors.push(String(error.code ?? error.message)); },",
		"    onExit: () => {},",
		"  });",
		"} catch (error) { startFailed = String(error?.code ?? error?.message ?? error); }",
		"await new Promise((resolve) => setImmediate(resolve));",
		'await writeFile(reportPath, JSON.stringify({ startFailed, errors }), "utf8");',
	].join("\n");
}

describe.skipIf(!bunAvailable || !posix)(
	"subprocess kernel stdin write failures (senpi#3016)",
	{ timeout: 60_000 },
	() => {
		it("Given a kernel child that closed its stdin when a frame is sent then the EPIPE is reported once through onError and the host survives", async () => {
			// given
			const root = await mkdtemp(join(tmpdir(), "senpi-stdin-epipe-"));
			try {
				const driverPath = join(root, "driver.ts");
				const reportPath = join(root, "report.json");
				await writeFile(driverPath, driverSource(), "utf8");

				// when
				const run = spawnSync("bun", [driverPath, reportPath], { encoding: "utf8", cwd: root, timeout: 45_000 });

				// then
				expect(run.status, run.stderr).toBe(0);
				const report: EpipeReport = JSON.parse(await readFile(reportPath, "utf8"));
				expect(report.errors).toEqual(["EPIPE"]);
				expect(report.sendAfterExit).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("Given a Python interpreter that closed its stdin when the transport sends its init frame then start fails with the EPIPE and the host survives", async () => {
			// given
			const root = await mkdtemp(join(tmpdir(), "senpi-py-stdin-epipe-"));
			try {
				const driverPath = join(root, "driver.ts");
				const reportPath = join(root, "report.json");
				await writeFile(driverPath, pythonDriverSource(), "utf8");

				// when
				const run = spawnSync("bun", [driverPath, reportPath], { encoding: "utf8", cwd: root, timeout: 45_000 });

				// then
				expect(run.status, run.stderr).toBe(0);
				const report: PythonEpipeReport = JSON.parse(await readFile(reportPath, "utf8"));
				expect(report.startFailed).toContain("EPIPE");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	},
);
