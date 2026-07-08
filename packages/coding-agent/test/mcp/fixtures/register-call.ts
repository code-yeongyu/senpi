import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { McpMappedContentBlock } from "../../../src/core/extensions/builtin/mcp/expose/schema-compat.ts";
import { getMcpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "../../../src/core/extensions/types.ts";
import { getMessageText, type Harness } from "../../suite/harness.ts";
import { type FakePi, fakePi, makeRoot, type TestRoot } from "./service-lifecycle.ts";

export type RegisteredMcpTool = ToolDefinition<TSchema, unknown, unknown>;

export interface CapturingPi extends FakePi {
	toolDefinitions: Map<string, RegisteredMcpTool>;
}

export function mcpRoot(slug: string, cleanupTasks: Array<() => Promise<void>>): TestRoot {
	return makeRoot(`register-call-${slug}`, cleanupTasks);
}

export async function attach(
	root: TestRoot,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
): Promise<void> {
	await getMcpService().attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true },
		pi,
		{ agentDir: root.agentDir },
	);
}

export function mcpExtensionFor(agentDir: string, activeTools?: string[]): ExtensionFactory {
	return (pi) => {
		let attached = false;
		const attachOnce = async (ctx: ExtensionContext): Promise<void> => {
			if (attached) return;
			attached = true;
			await getMcpService().attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: ctx.cwd, isProjectTrusted: ctx.isProjectTrusted },
				pi,
				{ agentDir },
			);
			if (activeTools) pi.setActiveTools(activeTools);
		};
		pi.on("before_agent_start", async (_event, ctx) => {
			await attachOnce(ctx);
		});
		pi.on("session_start", async (event, ctx) => {
			if (attached) return;
			attached = true;
			await getMcpService().attachSession(event, ctx, pi, { agentDir });
			if (activeTools) pi.setActiveTools(activeTools);
		});
		pi.on("session_shutdown", (event) => getMcpService().handleSessionShutdown(event));
	};
}

export function capturingPi(activeTools: string[] = []): CapturingPi {
	const base = fakePi(activeTools) as CapturingPi;
	base.toolDefinitions = new Map();
	base.registerTool = function registerTool<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void {
		base.toolDefinitions.set(tool.name, tool as RegisteredMcpTool);
		base.registeredTools.push(tool.name);
		base.activeTools.push(tool.name);
	};
	return base;
}

export function registeredTool(pi: CapturingPi, name: string): RegisteredMcpTool {
	const tool = pi.toolDefinitions.get(name);
	if (!tool) throw new Error(`missing registered tool ${name}`);
	return tool;
}

export function toolResultTexts(harness: Harness, toolName: string): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.filter((message): message is typeof message & { role: "toolResult"; toolName: string } => {
			const candidate = message as { role?: string; toolName?: string };
			return candidate.role === "toolResult" && candidate.toolName === toolName;
		})
		.map((message) => getMessageText(message));
}

export function textContent(result: AgentToolResult<unknown>): string {
	const text = result.content.find(
		(block): block is Extract<McpMappedContentBlock, { type: "text" }> => block.type === "text",
	);
	return text?.text ?? "";
}

export function readSchemaFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(import.meta.dirname, "schema", name), "utf8"));
}

export function testContext(): ExtensionContext {
	return { cwd: process.cwd() } as ExtensionContext;
}

export async function expectFileToContain(path: string, needle: string): Promise<void> {
	const deadline = Date.now() + 1500;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const text = await readFile(path, "utf8");
			if (text.includes(needle)) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw lastError instanceof Error ? lastError : new Error(`file did not contain ${needle}: ${path}`);
}

/** Strip the todo-39 resource utility tools so exact-list assertions written
 * before they existed keep pinning only the server-derived catalog. */
export function withoutMcpUtilityTools(names: readonly string[]): string[] {
	return names.filter((name) => name !== "mcp_list_resources" && name !== "mcp_read_resource");
}
