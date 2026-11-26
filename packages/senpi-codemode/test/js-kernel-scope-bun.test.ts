import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// senpi#7381: `jsCells.scope` installs `scope()`, whose resources close when the `await using` block exits.
const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const DRIVER_TIMEOUT_MS = 25_000;

const CELLS = {
	success: [
		'import { existsSync } from "node:fs";',
		"let dir; let child; let port;",
		"{",
		"  await using s = scope();",
		"  dir = await s.tempDir();",
		'  port = s.serve({ port: 0, fetch: () => new Response("ok") }).port;',
		'  child = s.spawn(["tail", "-f", "/dev/null"]);',
		'  await s.monitor({ command: "tail -f /dev/null", filter: "x" });',
		"}",
		'const served = await fetch("http://127.0.0.1:" + port + "/").then(() => true, () => false);',
		"return { dirExists: existsSync(dir), childEnded: child.exitCode !== null || child.signalCode !== null, served };",
	].join("\n"),
	thrown: [
		'import { existsSync } from "node:fs";',
		"let dir; let child;",
		"try {",
		"  await using s = scope();",
		"  dir = await s.tempDir();",
		'  child = s.spawn(["tail", "-f", "/dev/null"]);',
		'  throw new Error("boom");',
		"} catch (error) {",
		"  return { message: error.message, dirExists: existsSync(dir), childEnded: child.exitCode !== null || child.signalCode !== null };",
		"}",
	].join("\n"),
	idempotent: [
		'import { existsSync } from "node:fs";',
		"const s = scope();",
		"const dir = await s.tempDir();",
		"await s.disposeAsync();",
		"await s.disposeAsync();",
		'const refused = await scope().monitor({ command: "x", persistent: true }).then(() => "accepted", (error) => error.name);',
		"return { dirExists: existsSync(dir), disposed: s.disposed, refused };",
	].join("\n"),
	handoff: [
		'import { existsSync } from "node:fs";',
		"{",
		"  await using s = scope();",
		"  globalThis.keptDir = await s.tempDir();",
		"  globalThis.keptStack = s.move();",
		"}",
		"return existsSync(keptDir);",
	].join("\n"),
	handoffLater: [
		'import { existsSync } from "node:fs";',
		"const before = existsSync(keptDir);",
		"await keptStack.disposeAsync();",
		"return { before, after: existsSync(keptDir) };",
	].join("\n"),
	stopped: [
		"const s = scope();",
		"const dir = await s.tempDir();",
		'print("DIR=" + dir);',
		"await new Promise(() => {});",
	].join("\n"),
};

function driverSource(): string {
	return [
		'import { existsSync } from "node:fs";',
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		`const cells = ${JSON.stringify(CELLS)};`,
		'const kernel = new JavaScriptKernel({ sessionId: "scope-bun", cwd: process.cwd(), parallelPoolWidth: 1, scopeHelper: true });',
		"const calls = []; const held = []; let stoppedDir = '';",
		"const onMessage = (message) => {",
		'  if (message.type === "status" && message.event.op === "scope-monitor") held.push([message.event.bashId, message.event.held]);',
		'  if (message.type === "text") { const match = /DIR=(\\S+)/.exec(message.data); if (match) stoppedDir = match[1]; }',
		'  if (message.type !== "tool-call") return;',
		"  calls.push([message.toolName, message.args]);",
		'  const value = message.toolName === "monitor" ? { text: "started", details: { bash_id: "bash_9", monitor: true } } : { text: "Killed bash_9." };',
		'  kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: true, value });',
		"};",
		"const results = {};",
		"for (const [name, code] of Object.entries(cells)) {",
		'  const timeoutMs = name === "stopped" ? 3_000 : 60_000;',
		"  const result = await kernel.run({ cellId: name, code, timeoutMs, onMessage });",
		"  results[name] = result.ok ? JSON.parse(result.valueRepr ?? 'null') : { error: result.error.message };",
		"}",
		"const stoppedDirExists = stoppedDir !== '' && existsSync(stoppedDir);",
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ results, calls, held, stoppedDir, stoppedDirExists }), "utf8");',
	].join("\n");
}

async function runScopeDriver(): Promise<Record<string, unknown>> {
	const root = await mkdtemp(join(tmpdir(), "senpi-scope-bun-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(), "utf8");
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

describe.skipIf(!bunAvailable)("JavaScript kernel scope() under Bun", () => {
	it("closes what a scope opened on success, throw, repeat disposal and a stopped cell, and keeps a moved handoff", async () => {
		const report = await runScopeDriver();

		expect(report.results).toEqual({
			success: { dirExists: false, childEnded: true, served: false },
			thrown: { message: "boom", dirExists: false, childEnded: true },
			idempotent: { dirExists: false, disposed: true, refused: "TypeError" },
			handoff: true,
			handoffLater: { before: true, after: false },
			stopped: { error: expect.any(String) },
		});
		expect(report.calls).toEqual([
			["monitor", { command: "tail -f /dev/null", filter: "x" }],
			["kill_bash", { bash_id: "bash_9" }],
		]);
		expect(report.held).toEqual([
			["bash_9", true],
			["bash_9", false],
		]);
		expect(report.stoppedDir).not.toBe("");
		expect(report.stoppedDirExists).toBe(false);
	});
});
