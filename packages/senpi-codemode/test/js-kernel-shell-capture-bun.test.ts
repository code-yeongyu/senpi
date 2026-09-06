import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";

const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

type DriverReport = {
	readonly mode: string;
	readonly result: Extract<KernelToHostMessage, { type: "result" }>;
	readonly messages: readonly KernelToHostMessage[];
};

type DriverRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly report: DriverReport;
};

function driverSource(): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [code, reportPath] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "shell-capture", cwd: process.cwd(), parallelPoolWidth: 1 });',
		"const messages = [];",
		'const result = await kernel.run({ cellId: "shell-capture-cell", code, timeoutMs: 20_000, onMessage: (message) => messages.push(message) });',
		"await kernel.close();",
		'await writeFile(reportPath, JSON.stringify({ mode: kernel.mode, result, messages }), "utf8");',
	].join("\n");
}

async function runCellUnderBun(code: string): Promise<DriverRun> {
	const root = await mkdtemp(join(tmpdir(), "senpi-shell-capture-"));
	try {
		const driverPath = join(root, "driver.ts");
		const reportPath = join(root, "report.json");
		await writeFile(driverPath, driverSource(), "utf8");
		const run = spawnSync("bun", [driverPath, code, reportPath], { encoding: "utf8", cwd: root, timeout: 60_000 });
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status}: ${run.stderr}`);
		const report: DriverReport = JSON.parse(await readFile(reportPath, "utf8"));
		return { stdout: run.stdout, stderr: run.stderr, report };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function textOf(messages: readonly KernelToHostMessage[], stream: "stdout" | "stderr"): string {
	return messages
		.flatMap((message) => (message.type === "text" && message.stream === stream ? [message.data] : []))
		.join("");
}

describe.skipIf(!bunAvailable)("JavaScript kernel under Bun keeps child output off the host terminal", () => {
	it("Given a cell awaiting `Bun.$` without quiet when it runs then the output lands in the cell, not on fd 1", async () => {
		const run = await runCellUnderBun(
			"const r = await Bun.$`printf SHELL_LEAK_MARKER; sh -c 'printf SHELL_ERR_MARKER >&2'`.nothrow(); return r.exitCode",
		);

		expect(run.report.mode).toBe("worker");
		expect(run.report.result).toMatchObject({ ok: true, valueRepr: "0" });
		expect(run.stdout).not.toContain("SHELL_LEAK_MARKER");
		expect(run.stderr).not.toContain("SHELL_ERR_MARKER");
		expect(textOf(run.report.messages, "stdout")).toBe("SHELL_LEAK_MARKER");
		expect(textOf(run.report.messages, "stderr")).toBe("SHELL_ERR_MARKER");
	});

	it("Given a cell reading `Bun.$` through `.text()` when it runs then nothing is echoed anywhere", async () => {
		const run = await runCellUnderBun("return await Bun.$`printf TEXT_MARKER`.text()");

		expect(run.report.result).toMatchObject({ ok: true, valueRepr: '"TEXT_MARKER"' });
		expect(run.stdout).not.toContain("TEXT_MARKER");
		expect(textOf(run.report.messages, "stdout")).toBe("");
	});

	it("Given a cell spawning a child with the default stderr when it runs then the child's stderr stays off fd 2", async () => {
		const run = await runCellUnderBun(
			'const child = Bun.spawn(["sh", "-c", "printf SPAWN_LEAK_MARKER >&2"]); return await child.exited',
		);

		expect(run.report.result).toMatchObject({ ok: true, valueRepr: "0" });
		expect(run.stderr).not.toContain("SPAWN_LEAK_MARKER");
	});
});
