import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";

// omo#9371: the shipped engine runs the JS kernel as a Bun worker thread, where Bun.file,
// Bun.write, Bun.$, Bun.spawn and Bun.Glob resolved relative paths against the host process
// directory instead of the session's project directory.
const kernelModulePath = fileURLToPath(new URL("../src/kernels/js/context-manager.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

type CellResult = Extract<KernelToHostMessage, { type: "result" }>;

function driverSource(): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { JavaScriptKernel } from ${JSON.stringify(kernelModulePath)};`,
		"const [cwd, code, reportPath] = process.argv.slice(2);",
		'const kernel = new JavaScriptKernel({ sessionId: "session-cwd-bun", cwd, parallelPoolWidth: 1 });',
		'const result = await kernel.run({ cellId: "session-cwd-bun-cell", code, timeoutMs: 20_000 });',
		"await kernel.close();",
		"await writeFile(reportPath, JSON.stringify({ result, hostCwd: process.cwd() }), 'utf8');",
	].join("\n");
}

async function runCellUnderBun(project: string, code: string): Promise<{ result: CellResult; hostCwd: string }> {
	const host = await realpath(await mkdtemp(join(tmpdir(), "senpi-session-cwd-host-")));
	try {
		const driverPath = join(host, "driver.ts");
		const reportPath = join(host, "report.json");
		await writeFile(driverPath, driverSource(), "utf8");
		const run = spawnSync("bun", [driverPath, project, code, reportPath], {
			encoding: "utf8",
			cwd: host,
			timeout: 60_000,
		});
		if (run.status !== 0) throw new Error(`bun driver exited with ${run.status}: ${run.stderr}`);
		return JSON.parse(await readFile(reportPath, "utf8"));
	} finally {
		await rm(host, { recursive: true, force: true });
	}
}

describe.skipIf(!bunAvailable)("JavaScript kernel under Bun runs in the session's project directory", () => {
	it("Given a session on a project when a cell uses Bun's relative path APIs then they resolve in that project", async () => {
		// Given
		const project = await realpath(await mkdtemp(join(tmpdir(), "senpi-session-cwd-project-")));
		try {
			await writeFile(join(project, "package.json"), JSON.stringify({ name: "bun-project" }));
			await mkdir(join(project, "src"));
			await writeFile(join(project, "src", "todo.ts"), "one\ntwo\nthree\n");

			// When
			const { result, hostCwd } = await runCellUnderBun(
				project,
				[
					'await Bun.write("bun-written.txt", "from Bun.write");',
					"return {",
					"  cwd: process.cwd(),",
					'  name: (await Bun.file("package.json").json()).name,',
					'  lines: (await Bun.file("src/todo.ts").text()).trimEnd().split("\\n").length,',
					'  resolved: process.getBuiltinModule("node:path").resolve("src"),',
					"  shell: (await Bun.$`pwd`.text()).trim(),",
					'  spawned: new TextDecoder().decode(Bun.spawnSync(["pwd"]).stdout).trim(),',
					'  globbed: [...new Bun.Glob("src/*.ts").scanSync()],',
					"};",
				].join("\n"),
			);

			// Then
			if (!result.ok) throw new Error(`cell failed: ${result.error.message}`);
			expect(JSON.parse(result.valueRepr ?? "null")).toEqual({
				cwd: project,
				name: "bun-project",
				lines: 3,
				resolved: join(project, "src"),
				shell: project,
				spawned: project,
				globbed: ["src/todo.ts"],
			});
			expect(await readFile(join(project, "bun-written.txt"), "utf8")).toBe("from Bun.write");
			expect(hostCwd).not.toBe(project);
		} finally {
			await rm(project, { recursive: true, force: true });
		}
	});

	it("Given a relative path that only exists in the host directory when a cell reads it then it is not found", async () => {
		// Given: the file sits next to the host process, never inside the project.
		const project = await realpath(await mkdtemp(join(tmpdir(), "senpi-session-cwd-empty-")));
		try {
			// When
			const { result } = await runCellUnderBun(project, 'return await Bun.file("driver.ts").exists()');

			// Then
			expect(result).toMatchObject({ ok: true, valueRepr: "false" });
		} finally {
			await rm(project, { recursive: true, force: true });
		}
	});
});
