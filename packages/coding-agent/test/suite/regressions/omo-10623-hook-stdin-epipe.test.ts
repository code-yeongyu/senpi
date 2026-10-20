import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const commandRunnerPath = fileURLToPath(
	new URL("../../../src/core/extensions/builtin/hooks/command-runner.ts", import.meta.url),
);
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const posix = process.platform !== "win32";

type HookReport = { readonly crashed?: string; readonly exitCode?: number | null; readonly timedOut?: boolean };

// The hook is `true`: it exits without reading stdin, and the 4 MiB payload cannot fit a pipe buffer, so the
// write is still pending when the reader closes and must fail with EPIPE. The pending write keeps the driver's
// event loop alive until that error fires, so an unhandled stream error always reaches the uncaughtException
// handler below, which stands in for the TUI crash path's emergencyTerminalExit(129) (oh-my-openagent#10623).
function driverSource(): string {
	return [
		'import { writeFileSync } from "node:fs";',
		`import { runCommandHook } from ${JSON.stringify(commandRunnerPath)};`,
		"const [reportPath, cwd] = process.argv.slice(2);",
		'process.on("uncaughtException", (error) => {',
		"  writeFileSync(reportPath, JSON.stringify({ crashed: String(error.code ?? error.message) }));",
		"  process.exit(129);",
		"});",
		"const handler = {",
		'  config: { type: "command", command: "true" },',
		'  event: "UserPromptSubmit", groupIndex: 0, handlerIndex: 0,',
		'  source: { discoveredAt: "pre-session", displayOrder: 1, scope: "project", sourcePath: "/repo/.senpi/hooks.json" },',
		"};",
		'const input = { cwd, event: "UserPromptSubmit", prompt: "x".repeat(4 * 1024 * 1024) };',
		"const result = await runCommandHook(handler, input, { cwd });",
		"writeFileSync(reportPath, JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut }));",
	].join("\n");
}

describe("oh-my-openagent#10623: a hook that exits without reading stdin", () => {
	it.skipIf(!posix || !bunAvailable)("reports its exit code instead of crashing the host with EPIPE", async () => {
		// Given
		const dir = await mkdtemp(join(tmpdir(), "senpi-10623-"));
		try {
			const driverPath = join(dir, "driver.mjs");
			const reportPath = join(dir, "report.json");
			await writeFile(driverPath, driverSource(), "utf8");

			// When
			const run = spawnSync("bun", [driverPath, reportPath, dir], { encoding: "utf8", timeout: 30_000 });

			// Then
			const report = JSON.parse(await readFile(reportPath, "utf8")) as HookReport;
			expect(report).toEqual({ exitCode: 0, timedOut: false });
			expect(run.status, run.stderr).toBe(0);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
