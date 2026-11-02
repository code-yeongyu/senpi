import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach } from "vitest";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { JsEnvironments } from "../../src/environments/js-environments.ts";
import { createCodemodeSessionManager } from "../../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../../src/interpreters/detect.ts";
import { createEvalTool } from "../../src/tool/eval-tool.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";

export const settings = { ...defaultCodemodeSettings, languages: { js: true, py: false, rb: false, jl: false } };
export const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

export function hasCommand(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export async function packFixture(
	dir: string,
	name: string,
	version: string,
	source: string,
	dependencies?: Record<string, string>,
	manifest: Record<string, unknown> = {},
) {
	const pkg = join(dir, `${name}-src`);
	await mkdir(pkg, { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({
			name,
			version,
			type: "module",
			main: "index.js",
			...(dependencies ? { dependencies } : {}),
			...manifest,
		}),
	);
	await writeFile(join(pkg, "index.js"), source);
	execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: pkg, stdio: "ignore" });
	return join(dir, `${name}-${version}.tgz`);
}

export async function session(
	installer: "auto" | "bun" | "npm" = "auto",
	managedRoot?: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	const root = await mkdtemp(join(tmpdir(), "senpi-js-magic-"));
	const project = join(root, "project");
	const fixtures = join(root, "fixtures");
	await mkdir(project, { recursive: true });
	await mkdir(fixtures, { recursive: true });
	await writeFile(join(project, "package.json"), '{"name":"user-project","private":true}\n');
	const runSettings = {
		...settings,
		environments: { js: { installer }, ...(managedRoot === undefined ? {} : { managedRoot }) },
	};
	const environments = new JsEnvironments({
		artifactsDir: join(root, "artifacts"),
		cwd: project,
		runtime: "test",
		env,
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
	return { root, project, fixtures, environments, run, dispose: () => manager.dispose() };
}
