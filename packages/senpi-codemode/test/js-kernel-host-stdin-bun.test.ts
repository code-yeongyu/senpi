import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const CELL_TIMEOUT_MS = 5_000;

type Report = { readonly mode: string; readonly result: Extract<KernelToHostMessage, { type: "result" }> };

function driverSource(): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [code, reportPath] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "host-stdin", cwd: process.cwd(), parallelPoolWidth: 1 });',
		`const result = await kernel.run({ cellId: "host-stdin-cell", code, timeoutMs: ${CELL_TIMEOUT_MS}, onMessage: () => {} });`,
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ mode: kernel.mode, result }), "utf8");',
	].join("\n");
}

// The host's stdin stays open and silent, like the TUI's terminal: a cell that reads the shared fd 0
// would block until the host types something, and the read would keep consuming the user's keys.
async function runCellWithOpenHostStdin(code: string): Promise<Report> {
	const root = await mkdtemp(join(tmpdir(), "senpi-host-stdin-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(), "utf8");
		const child = spawn("bun", [driverPath, code, reportPath], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdout.resume();
		const [status] = (await once(child, "exit")) as [number | null];
		child.stdin.end();
		if (status !== 0) throw new Error(`bun driver exited with ${status}: ${stderr}`);
		return JSON.parse(await readFile(reportPath, "utf8"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe.skipIf(!bunAvailable)("JavaScript kernel under Bun never reads the host's stdin", () => {
	it.each([
		["fs.readFileSync('/dev/stdin')", "return (await import('node:fs')).readFileSync('/dev/stdin', 'utf8').length"],
		["fs.readFileSync(0)", "return (await import('node:fs')).default.readFileSync(0, 'utf8').length"],
		[
			"fs.promises.readFile('/dev/stdin')",
			"return (await (await import('node:fs/promises')).readFile('/dev/stdin', 'utf8')).length",
		],
		["Bun.stdin", "return (await Bun.stdin.text()).length"],
		["Bun.file('/dev/stdin')", "return (await Bun.file('/dev/stdin').text()).length"],
	])(
		"Given the host keeps its stdin open when a cell reads %s then the cell sees EOF instead of the host's input",
		async (_name, code) => {
			const report = await runCellWithOpenHostStdin(code);

			expect(report.mode).toBe("worker");
			expect(report.result).toMatchObject({ ok: true, valueRepr: "0" });
		},
	);

	it("Given stdin isolation when a cell reads an ordinary file then the file contents still come back", async () => {
		const report = await runCellWithOpenHostStdin(
			"const fs = await import('node:fs'); fs.writeFileSync('own.txt', 'own-input'); return [fs.readFileSync('own.txt', 'utf8'), await Bun.file('own.txt').text()]",
		);

		expect(report.result).toMatchObject({ ok: true, valueRepr: '["own-input","own-input"]' });
	});
});
