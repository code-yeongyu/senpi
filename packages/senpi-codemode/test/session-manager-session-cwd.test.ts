import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import type { EvalLanguage } from "../src/tool/types.ts";
import { hasPython3 } from "./py-kernel/fixtures.ts";

// omo#9371: the JS kernel is a worker thread, which can never chdir, so relative paths in a
// cell resolved against the host process directory (the desktop's state dir, or wherever
// `omo -p --cwd <P>` was launched) instead of the session's project directory.
const pythonAvailable = await hasPython3();

const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v24" } },
	py: pythonAvailable
		? { enabled: true, detected: { ok: true, path: "python3", version: "3" } }
		: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

// The cell writes into a directory that exists only inside the temp project, so a regression
// fails the write with ENOENT instead of leaving a file in the host directory.
const projectCell = (outputDir: string): string =>
	[
		'const fs = process.getBuiltinModule("node:fs");',
		'const fsp = process.getBuiltinModule("node:fs/promises");',
		'const path = process.getBuiltinModule("node:path");',
		'const cp = process.getBuiltinModule("node:child_process");',
		`fs.writeFileSync(${JSON.stringify(`${outputDir}/written-by-cell.txt`)}, "from the cell");`,
		'const probe = await import("./probe.mjs");',
		"return {",
		"  cwd: process.cwd(),",
		'  syncName: JSON.parse(fs.readFileSync("package.json", "utf8")).name,',
		'  promiseName: JSON.parse(await fsp.readFile("package.json", "utf8")).name,',
		'  listed: fs.readdirSync(".").includes("package.json"),',
		'  resolved: path.resolve("src"),',
		'  child: cp.execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { encoding: "utf8" }),',
		"  module: probe.name,",
		"};",
	].join("\n");

function makeProject(root: string, name: string, outputDir?: string): string {
	const project = join(root, name);
	mkdirSync(project, { recursive: true });
	if (outputDir) mkdirSync(join(project, outputDir));
	writeFileSync(join(project, "package.json"), JSON.stringify({ name }));
	writeFileSync(join(project, "probe.mjs"), `export const name = ${JSON.stringify(`${name}-module`)};\n`);
	return project;
}

async function startManager(cwd: string): Promise<CodemodeSessionManager> {
	return await createCodemodeSessionManager({
		sessionId: `session-cwd-${crypto.randomUUID()}`,
		cwd,
		settings: defaultCodemodeSettings,
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => {
			throw new Error("completion is not exercised in this test");
		},
	});
}

async function runCell(manager: CodemodeSessionManager, language: EvalLanguage, code: string): Promise<unknown> {
	const kernel = await manager.getKernel(language, () => {});
	const result = await kernel.run({ cellId: `cwd-${crypto.randomUUID()}`, code, timeoutMs: 20_000 });
	if (!result.ok) throw new Error(`${language} cell failed: ${result.error.message}`);
	return result.valueRepr === undefined ? undefined : JSON.parse(result.valueRepr);
}

describe("codemode eval kernels run in the session's project directory", () => {
	const managers: CodemodeSessionManager[] = [];
	let root = "";

	afterEach(async () => {
		await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
		if (root) rmSync(root, { recursive: true, force: true });
		root = "";
	});

	async function open(cwd: string): Promise<CodemodeSessionManager> {
		const manager = await startManager(cwd);
		managers.push(manager);
		return manager;
	}

	it("Given a session opened on a project when a js cell uses relative paths then they resolve in that project", async () => {
		// Given: the host runs somewhere else, the way a shared RPC host runs from its state dir.
		root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-")));
		const outputDir = `cell-output-${crypto.randomUUID()}`;
		const project = makeProject(root, "project-a", outputDir);
		const hostCwd = process.cwd();
		const manager = await open(project);

		// When
		const value = await runCell(manager, "js", projectCell(outputDir));

		// Then
		expect(value).toEqual({
			cwd: project,
			syncName: "project-a",
			promiseName: "project-a",
			listed: true,
			resolved: join(project, "src"),
			child: project,
			module: "project-a-module",
		});
		expect(await readFile(join(project, outputDir, "written-by-cell.txt"), "utf8")).toBe("from the cell");
		// The host (and the bash tool spawning from it) keeps its own directory.
		expect(process.cwd()).toBe(hostCwd);
		expect(existsSync(join(hostCwd, outputDir))).toBe(false);
		expect(execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { encoding: "utf8" })).toBe(
			realpathSync(hostCwd),
		);
	});

	it("Given relative Buffer and file: URL paths when a js cell reads them then they resolve in the project", async () => {
		// Given
		root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-buffer-")));
		const project = makeProject(root, "project-buffer");
		writeFileSync(join(project, "data.txt"), "project data");
		mkdirSync(join(project, "nested"));
		writeFileSync(join(project, "nested", "inner.txt"), "nested data");
		const manager = await open(project);

		// When
		const value = await runCell(
			manager,
			"js",
			[
				'const fs = process.getBuiltinModule("node:fs");',
				'const fsp = process.getBuiltinModule("node:fs/promises");',
				'const { pathToFileURL } = process.getBuiltinModule("node:url");',
				"return {",
				'  promiseBuffer: await fsp.readFile(Buffer.from("data.txt"), "utf8"),',
				'  syncBuffer: fs.readFileSync(Buffer.from("nested/inner.txt"), "utf8"),',
				'  bytes: fs.existsSync(new TextEncoder().encode("data.txt")),',
				'  url: await fsp.readFile(new URL("data.txt", pathToFileURL(process.cwd() + "/")), "utf8"),',
				"};",
			].join("\n"),
		);

		// Then
		expect(value).toEqual({
			promiseBuffer: "project data",
			syncBuffer: "nested data",
			bytes: true,
			url: "project data",
		});
	});

	it("Given an absolute Buffer path when a js cell reads it then the path is used as given", async () => {
		// Given
		root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-abs-buffer-")));
		const project = makeProject(root, "project-abs-buffer");
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside data");
		const manager = await open(project);

		// When
		const value = await runCell(
			manager,
			"js",
			`return process.getBuiltinModule("node:fs").readFileSync(Buffer.from(${JSON.stringify(outside)}), "utf8")`,
		);

		// Then
		expect(value).toBe("outside data");
	});

	it("Given an explicit relative cwd for a child when a js cell spawns it then it is taken from the project", async () => {
		// Given
		root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-child-")));
		const project = makeProject(root, "project-child");
		mkdirSync(join(project, "nested"));
		const manager = await open(project);

		// When
		const value = await runCell(
			manager,
			"js",
			[
				'const cp = process.getBuiltinModule("node:child_process");',
				'return cp.execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: "nested", encoding: "utf8" });',
			].join("\n"),
		);

		// Then
		expect(value).toBe(join(project, "nested"));
	});

	it("Given the session moves to another project when the next js cell runs then it sees the new directory", async () => {
		// Given: session_start replaces the session runtime when the session's cwd changes.
		root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-switch-")));
		const first = makeProject(root, "project-first");
		const second = makeProject(root, "project-second");
		const before = await open(first);
		expect(
			await runCell(before, "js", 'return process.getBuiltinModule("node:fs").readFileSync("package.json", "utf8")'),
		).toBe(JSON.stringify({ name: "project-first" }));
		await before.dispose();

		// When
		const after = await open(second);
		const value = await runCell(
			after,
			"js",
			'return [process.cwd(), JSON.parse(process.getBuiltinModule("node:fs").readFileSync("package.json", "utf8")).name]',
		);

		// Then
		expect(value).toEqual([second, "project-second"]);
	});

	it.skipIf(!pythonAvailable)(
		"Given a session opened on a project when a python cell uses relative paths then they resolve in that project",
		async () => {
			// Given
			root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-py-")));
			const project = makeProject(root, "project-py");
			const manager = await open(project);

			// When
			const kernel = await manager.getKernel("py", () => {});
			const result = await kernel.run({
				cellId: "py-cwd",
				code: 'import json, os\nos.getcwd() + "|" + json.load(open("package.json"))["name"]',
				timeoutMs: 20_000,
			});

			// Then
			expect(result).toMatchObject({ ok: true, valueRepr: `'${project}|project-py'` });
		},
	);

	it.each([{ language: "js" as const }, ...(pythonAvailable ? [{ language: "py" as const }] : [])])(
		"Given a session whose directory does not exist when a $language cell starts then it fails with a named error",
		async ({ language }) => {
			// Given
			root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-missing-")));
			const missing = join(root, "never-created");
			const manager = await open(missing);

			// When
			const started = manager.getKernel(language, () => {});

			// Then
			await expect(started).rejects.toMatchObject({ name: "CodemodeSessionCwdUnavailableError", cwd: missing });
			await expect(started).rejects.toThrow(missing);
		},
	);

	it("Given a session directory under a regular file when a js cell starts then it fails with the named error", async () => {
		// Given
		root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-notdir-")));
		writeFileSync(join(root, "a-file"), "");
		const underFile = join(root, "a-file", "project");
		const manager = await open(underFile);

		// When
		const started = manager.getKernel("js", () => {});

		// Then
		await expect(started).rejects.toMatchObject({ name: "CodemodeSessionCwdUnavailableError", cwd: underFile });
	});

	it.skipIf(process.platform === "win32")(
		"Given a session directory that cannot be resolved for another reason when a js cell starts then the real error surfaces",
		async () => {
			// Given: a self-referential symlink exists, so the directory is not gone and reopening would not help.
			root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-loop-")));
			const loop = join(root, "loop");
			symlinkSync(loop, loop);
			const manager = await open(loop);

			// When
			const outcome = await manager
				.getKernel("js", () => {})
				.then(
					() => undefined,
					(error: unknown) => error,
				);

			// Then
			expect(outcome).toMatchObject({ code: "ELOOP" });
			expect(outcome).not.toMatchObject({ name: "CodemodeSessionCwdUnavailableError" });
		},
	);

	it("Given the project directory is deleted mid-session when the next js cell starts then it fails with a named error", async () => {
		// Given
		root = realpathSync(mkdtempSync(join(tmpdir(), "codemode-session-cwd-deleted-")));
		const project = makeProject(root, "project-deleted");
		const manager = await open(project);
		expect(await runCell(manager, "js", "return process.cwd()")).toBe(project);

		// When
		rmSync(project, { recursive: true, force: true });
		const next = manager.getKernel("js", () => {});

		// Then: never a silent fallback to the host directory.
		await expect(next).rejects.toMatchObject({ name: "CodemodeSessionCwdUnavailableError", cwd: project });
	});
});
