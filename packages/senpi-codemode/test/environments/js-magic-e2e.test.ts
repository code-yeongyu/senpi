import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { JsEnvironments } from "../../src/environments/js-environments.ts";
import { createCodemodeSessionManager } from "../../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../../src/interpreters/detect.ts";
import { createEvalTool } from "../../src/tool/eval-tool.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";

const settings = { ...defaultCodemodeSettings, languages: { js: true, py: false, rb: false, jl: false } };
const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function hasCommand(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function packFixture(
	dir: string,
	name: string,
	version: string,
	source: string,
	dependencies?: Record<string, string>,
) {
	const pkg = join(dir, `${name}-src`);
	await mkdir(pkg, { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name, version, type: "module", main: "index.js", ...(dependencies ? { dependencies } : {}) }),
	);
	await writeFile(join(pkg, "index.js"), source);
	execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: pkg, stdio: "ignore" });
	return join(dir, `${name}-${version}.tgz`);
}

async function session(installer: "auto" | "bun" | "npm" = "auto") {
	const root = await mkdtemp(join(tmpdir(), "senpi-js-magic-"));
	const project = join(root, "project");
	const fixtures = join(root, "fixtures");
	await mkdir(project, { recursive: true });
	await mkdir(fixtures, { recursive: true });
	await writeFile(join(project, "package.json"), '{"name":"user-project","private":true}\n');
	const runSettings = { ...settings, environments: { js: { installer } } };
	const environments = new JsEnvironments({
		artifactsDir: join(root, "artifacts"),
		cwd: project,
		runtime: "test",
		env: process.env,
		settings: runSettings,
	});
	const fail = async () => {
		throw new Error("no host tools or provider calls in this test");
	};
	const manager = await createCodemodeSessionManager({
		sessionId: `js-magic-${crypto.randomUUID()}`,
		cwd: project,
		settings,
		availability,
		executeTool: fail,
		complete: fail,
	});
	const tool = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: manager,
		executeTool: fail,
		cellTimeoutSeconds: 120,
		jsEnvironments: environments,
	});
	cleanups.push(async () => {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const context = { ...fakeExtensionContext(), cwd: project };
	const run = async (code: string, signal?: AbortSignal) =>
		await tool.execute(
			`js-magic-${crypto.randomUUID()}`,
			{ language: "js", code, summary: "Run a cell" },
			signal,
			undefined,
			context,
		);
	return { project, fixtures, environments, run };
}

const probeSource = 'export const probe = () => "ok";\n';
const secondSource = 'export const second = () => "two";\n';

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a JavaScript eval session", () => {
	it("When %bun add installs a local tarball, then the next cell imports it and the project's package.json is untouched", async () => {
		const { project, fixtures, run } = await session("bun");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const manifest = await readFile(join(project, "package.json"), "utf8");

		const install = await run(`%bun add ${tarball}`);
		const imported = await run('const { probe } = await import("senpi-probe");\nprobe()');

		expect(textOf(install)).toMatch(/added senpi-probe with bun into managed \(revision 1\)/);
		expect(textOf(imported)).toContain("ok");
		expect(await readFile(join(project, "package.json"), "utf8")).toBe(manifest);
		expect(existsSync(join(project, "node_modules"))).toBe(false);
	}, 180_000);

	it("When npm is the installer, then %npm add installs the same way", async () => {
		const { fixtures, run } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);

		const install = await run(`%npm add ${tarball}`);
		const imported = await run('const { probe } = await import("senpi-probe");\nprobe()');

		expect(textOf(install)).toMatch(/added senpi-probe with npm into managed \(revision 1\)/);
		expect(textOf(imported)).toContain("ok");
	}, 180_000);

	it("When a second install succeeds, then the new revision still resolves the first package", async () => {
		const { fixtures, run } = await session("bun");
		const first = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-second", "1.0.0", secondSource);

		await run(`%bun add ${first}`);
		const install = await run(`%bun add ${second}`);
		const both = await run(
			'const a = await import("senpi-probe");\nconst b = await import("senpi-second");\n[a.probe(), b.second()].join("+")',
		);

		expect(textOf(install)).toMatch(/revision 2/);
		expect(textOf(both)).toContain("ok+two");
	}, 180_000);

	it("When an install fails, then the cell reports environment_install_failed and the previous revision stays active", async () => {
		const { fixtures, environments, run } = await session("bun");
		const good = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const broken = await packFixture(fixtures, "senpi-broken", "1.0.0", "export const x = 1;\n", {
			"senpi-nonexistent-dependency-for-tests": "file:./does-not-exist",
		});
		await run(`%bun add ${good}`);
		const before = environments.packageRoot;

		const failure = await run(`%bun add ${broken}`);
		const still = await run('const { probe } = await import("senpi-probe");\nprobe()');

		expect(textOf(failure)).toContain("environment_install_failed");
		expect(environments.packageRoot).toBe(before);
		expect(textOf(still)).toContain("ok");
	}, 180_000);

	it("When %environment project is selected, then installs go into the project directory", async () => {
		const { project, fixtures, run } = await session("bun");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);

		const switched = await run("%environment project");
		const install = await run(`%bun add ${tarball}`);

		expect(textOf(switched)).toContain("environment: project");
		expect(textOf(install)).toContain("into project");
		expect(existsSync(join(project, "node_modules", "senpi-probe"))).toBe(true);
	}, 180_000);

	it("When the cell is cancelled once the installer has started, then the installer tree exits, nothing is published, the project manifest is unchanged and the kernel answers the next cell", async () => {
		const { project, fixtures, environments, run } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const manifest = await readFile(join(project, "package.json"), "utf8");
		const controller = new AbortController();
		const installerStarted = Promise.withResolvers<void>();
		const original = environments.install.bind(environments);
		environments.install = (requested, signal, onOutput) => {
			installerStarted.resolve();
			return original(requested, signal, onOutput);
		};

		const pending = run(`%npm add ${tarball}`, controller.signal);
		await installerStarted.promise;
		controller.abort();
		await expect(pending).rejects.toThrow(/interrupted|aborted/i);
		const next = await run("40 + 2");

		expect(environments.packageRoot).toBeUndefined();
		expect(await readFile(join(project, "package.json"), "utf8")).toBe(manifest);
		expect(textOf(next)).toContain("42");
	}, 180_000);

	it("When installer flags are passed, then the cell is refused because the host chooses the destination", async () => {
		const { run } = await session("bun");

		const refused = await run("%bun add --global left-pad");

		expect(textOf(refused)).toContain("installer flags are chosen by the host");
	}, 60_000);
});
