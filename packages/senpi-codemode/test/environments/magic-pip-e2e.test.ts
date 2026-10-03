import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { PythonEnvironments } from "../../src/environments/python-environments.ts";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { createCodemodeSessionManager } from "../../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../../src/interpreters/detect.ts";
import { createEvalTool } from "../../src/tool/eval-tool.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";
import { buildWheel, hasPythonWithPip, siteFilesSnapshot } from "./wheel-fixtures.ts";

const settings = { ...defaultCodemodeSettings, languages: { js: false, py: true, rb: false, jl: false } };
const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
const pythonReady = availability.py.detected.ok && hasPythonWithPip();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function session() {
	const root = await mkdtemp(join(tmpdir(), "senpi-magic-pip-"));
	const wheels = join(root, "wheels");
	const artifactsDir = join(root, "artifacts");
	await mkdir(wheels, { recursive: true });
	const interpreter = availability.py.detected.ok ? availability.py.detected.path : "python3";
	const environments = new PythonEnvironments({ artifactsDir, cwd: root, interpreter, settings });
	const manager = await createCodemodeSessionManager({
		sessionId: `magic-pip-${crypto.randomUUID()}`,
		cwd: root,
		settings,
		availability,
		executeTool: async () => {
			throw new Error("no host tools in this test");
		},
		complete: async () => {
			throw new Error("no provider calls in this test");
		},
	});
	const tool = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: manager,
		executeTool: async () => {
			throw new Error("no host tools in this test");
		},
		cellTimeoutSeconds: 120,
		pythonEnvironments: environments,
	});
	cleanups.push(async () => {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const run = async (code: string) =>
		await tool.execute(
			`magic-cell-${crypto.randomUUID()}`,
			{ language: "py", code, summary: "Exercise a magic cell" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);
	return { root, wheels, artifactsDir, environments, run };
}

describe.skipIf(!pythonReady)("Given a Python eval session", () => {
	it("When a cell runs %pip install on a local wheel, then the next cell imports the package without a kernel restart", async () => {
		const { wheels, run } = await session();
		const wheel = buildWheel(wheels, "senpi_probe", "1.0");
		const before = await run("import os; sentinel = object(); (os.getpid(), id(sentinel))");

		const install = await run(`%pip install --no-index ${wheel}`);
		const imported = await run("import os, senpi_probe; (senpi_probe.VERSION, os.getpid(), id(sentinel))");

		expect(textOf(install)).toMatch(/installed senpi-probe-1\.0 into managed \(revision 1\)/);
		const pidAndSentinel = textOf(before)
			.match(/\((\d+), (\d+)\)/)
			?.slice(1)
			.join(", ");
		expect(textOf(imported)).toContain(`('1.0', ${pidAndSentinel})`);
	}, 180_000);

	it("When an install fails, then the cell reports pip's error, the active revision is unchanged and earlier packages still import", async () => {
		const { wheels, run, environments } = await session();
		await run(`%pip install --no-index ${buildWheel(wheels, "senpi_probe", "1.0")}`);
		const activeBefore = environments.activeRoot;
		const broken = buildWheel(wheels, "senpi_broken", "1.0", ["senpi-nonexistent-dependency"]);

		const failure = await run(`%pip install --no-index ${broken}`);
		const still = await run("import senpi_probe; senpi_probe.VERSION");

		expect(textOf(failure)).toContain("environment_install_failed");
		expect(textOf(failure)).toContain("No matching distribution");
		expect(environments.activeRoot).toBe(activeBefore);
		expect(textOf(still)).toContain("'1.0'");
	}, 180_000);

	it("When a cell mixes %pip with code, then it fails with the own-cell teaching error and installs nothing", async () => {
		const { wheels, run, artifactsDir } = await session();
		const wheel = buildWheel(wheels, "senpi_probe", "1.0");

		const mixed = await run(`%pip install --no-index ${wheel}\nimport senpi_probe`);

		expect(textOf(mixed)).toContain("put %pip on its own cell");
		await expect(readdir(join(artifactsDir, "environments"))).rejects.toMatchObject({ code: "ENOENT" });
	}, 120_000);

	it("When %environment project is selected, then installs go to the project-local target and the interpreter's own site-packages and the user site stay untouched", async () => {
		const { root, wheels, run } = await session();
		const wheel = buildWheel(wheels, "senpi_probe", "1.0");
		const siteBefore = siteFilesSnapshot();

		const switched = await run("%environment project");
		const install = await run(`%pip install --no-index ${wheel}`);
		const imported = await run("import senpi_probe; senpi_probe.__file__");

		expect(textOf(switched)).toContain("environment: project");
		expect(textOf(install)).toContain("into project");
		expect(textOf(imported)).toContain(join(root, ".senpi", "python-packages"));
		expect((await readActiveRevision(join(root, ".senpi", "python-packages")))?.number).toBe(1);
		expect(siteFilesSnapshot()).toBe(siteBefore);
	}, 180_000);
});
