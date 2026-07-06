import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type TSchema, Type } from "typebox";
import type { getMcpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import type { ExtensionAPI, ToolDefinition } from "../../../src/core/extensions/types.ts";
import { stdioFixtureCommand } from "./spawn-fixture.ts";

const execFileAsync = promisify(execFile);

export interface TestRoot {
	agentDir: string;
	cwd: string;
}

export interface FakePi extends Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool"> {
	activeTools: string[];
	registeredTools: string[];
	setActiveCalls: string[][];
}

export async function cleanupRoots(cleanupTasks: Array<() => Promise<void>>): Promise<void> {
	for (const cleanup of cleanupTasks.splice(0).reverse()) {
		await cleanup();
	}
}

export function makeRoot(slug: string, cleanupTasks: Array<() => Promise<void>>): TestRoot {
	const root = mkdtempSync(join(tmpdir(), `senpi-mcp-service-${slug}-`));
	const testRoot = { agentDir: join(root, "agent"), cwd: join(root, "project") };
	mkdirSync(testRoot.agentDir, { recursive: true });
	mkdirSync(join(testRoot.cwd, ".senpi"), { recursive: true });
	cleanupTasks.push(() => rm(root, { recursive: true, force: true }));
	return testRoot;
}

export function setConfig(root: TestRoot, servers: Record<string, unknown>): void {
	writeJson(join(root.agentDir, "mcp.json"), { mcpServers: servers });
}

export function writeProjectConfig(cwd: string, servers: Record<string, unknown>): void {
	writeJson(join(cwd, ".senpi", "mcp.json"), { mcpServers: servers });
}

export function stdioServer(extraArgs: string[]): Record<string, unknown> {
	const fixture = stdioFixtureCommand();
	return { type: "stdio", command: fixture.command, args: [...fixture.args, ...extraArgs], connectTimeoutMs: 2000 };
}

export async function attach(
	service: ReturnType<typeof getMcpService>,
	root: TestRoot,
	reason: "startup" | "reload" | "new",
	projectTrusted = true,
): Promise<void> {
	await service.attachSession(sessionStart(reason), contextFor(root, projectTrusted), fakePi(), {
		agentDir: root.agentDir,
	});
}

export function fakePi(activeTools: string[] = []): FakePi {
	return new FakeExtensionApi(activeTools);
}

export function tool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

export function requiredPid(service: ReturnType<typeof getMcpService>, name: string): number {
	const pid = service.getConnection(name)?.getRootPid();
	if (pid === null || pid === undefined) throw new Error(`missing pid for ${name}`);
	return pid;
}

export async function readCounter(file: string): Promise<number> {
	const raw = await readFile(file, "utf8");
	return Number(raw.trim());
}

export async function assertAlive(pid: number): Promise<void> {
	await execFileAsync("kill", ["-0", String(pid)]);
}

class FakeExtensionApi implements FakePi {
	activeTools: string[];
	registeredTools: string[] = [];
	setActiveCalls: string[][] = [];

	constructor(activeTools: string[]) {
		this.activeTools = [...activeTools];
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(toolNames: string[]): void {
		this.activeTools = [...toolNames];
		this.setActiveCalls.push([...toolNames]);
	}

	registerTool<TParams extends TSchema, TDetails, TState>(
		toolDefinition: ToolDefinition<TParams, TDetails, TState>,
	): void {
		this.registeredTools.push(toolDefinition.name);
		this.activeTools.push(toolDefinition.name);
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sessionStart(reason: "startup" | "reload" | "new") {
	return { type: "session_start" as const, reason };
}

function contextFor(root: TestRoot, projectTrusted = true) {
	return { cwd: root.cwd, isProjectTrusted: () => projectTrusted };
}
