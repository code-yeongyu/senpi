// Brain/hand split plan row S16c: one loaded MCP extension (one runtime) driven by a runner per execution scope,
// each scope with its own session and UI, against real MCP servers declared in the agent's mcp.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { MCP_CONTROL_INVENTORY_REQUEST_EVENT } from "../../src/core/extensions/builtin/mcp/control-inventory.ts";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import type { McpWireStatusSnapshot } from "../../src/core/extensions/builtin/mcp/service-types.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionMode, ExtensionToolContext, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { wrapRegisteredTools } from "../../src/core/extensions/wrapper.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

export interface McpTestScope {
	readonly runner: ExtensionRunner;
	readonly sessionId: string;
}

export interface McpScopedRuntime {
	readonly service: McpService;
	readonly scopes: readonly McpTestScope[];
	readonly agentDir: string;
	answered(sessionId: string): boolean;
	/** The control inventory the scope's session is answered with, or undefined when nothing answers it. */
	inventory(sessionId: string): Promise<McpWireStatusSnapshot | undefined>;
	/** The scope's first tool call: the runtime attaches the scope (RT5b first-use attach). */
	attach(scope: McpTestScope): Promise<void>;
	call(scope: McpTestScope, toolName: string, args?: Record<string, unknown>): Promise<string>;
	dispose(): Promise<void>;
}

export interface McpScopedRuntimeOptions {
	readonly uis: readonly ExtensionUIContext[];
	readonly servers?: Record<string, unknown>;
	readonly mode?: ExtensionMode;
	readonly prepare?: (agentDir: string) => Promise<void>;
}

/** A user skill on disk; `servers` becomes its mcp.json sidecar. */
export function writeSkill(root: string, name: string, servers: Record<string, unknown> = {}): Skill {
	const baseDir = join(root, "skills", name);
	mkdirSync(baseDir, { recursive: true });
	const filePath = join(baseDir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n${name}\n`);
	if (Object.keys(servers).length > 0)
		writeFileSync(join(baseDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
	return {
		name,
		description: name,
		filePath,
		baseDir,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test", scope: "user" }),
		disableModelInvocation: false,
	};
}

/** A turn of the scope whose system prompt lists `skills`. */
export async function startTurn(scope: McpTestScope, skills: Skill[]): Promise<void> {
	await scope.runner.emitBeforeAgentStart("turn", undefined, "BASE", {
		cwd: scope.runner.createContext().cwd,
		skills,
	});
}

export async function mcpRuntimeWithScopes(options: McpScopedRuntimeOptions): Promise<McpScopedRuntime> {
	const dir = mkdtempSync(join(tmpdir(), "scope-mcp-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: options.servers ?? {} })}\n`);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	await options.prepare?.(agentDir);
	const service = new McpService();
	const extensions = await createTestExtensionsResult([createMcpExtension(service)], dir);
	const bus = extensions.eventBus;
	if (bus === undefined) throw new Error("the test extensions have no event bus");
	// The host's tool table for this runtime: one active set its scopes share.
	let active: string[] = [];
	extensions.runtime.getActiveTools = () => [...active];
	extensions.runtime.setActiveTools = (names) => {
		active = [...names];
	};
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const scopes = options.uis.map((ui) => {
		const sessionManager = SessionManager.inMemory(dir);
		const runner = new ExtensionRunner(
			extensions.extensions,
			extensions.runtime,
			dir,
			sessionManager,
			modelRegistry,
			extensions.eventBus,
		);
		runner.setUIContext(ui, options.mode ?? "tui");
		return { runner, sessionId: sessionManager.getSessionId() };
	});
	let calls = 0;
	return {
		service,
		scopes,
		agentDir,
		answered(sessionId) {
			let responded = false;
			bus.emit(MCP_CONTROL_INVENTORY_REQUEST_EVENT, {
				sessionId,
				respond: () => {
					responded = true;
				},
			});
			return responded;
		},
		async inventory(sessionId) {
			let snapshot: Promise<McpWireStatusSnapshot> | undefined;
			bus.emit(MCP_CONTROL_INVENTORY_REQUEST_EVENT, {
				sessionId,
				respond: (answer: Promise<McpWireStatusSnapshot>) => {
					snapshot = answer;
				},
			});
			return await snapshot;
		},
		async attach(scope) {
			calls += 1;
			await scope.runner.emitToolCall({
				type: "tool_call",
				toolName: "read",
				input: { path: "a.txt" },
				toolCallId: `attach-${calls}`,
			});
			await service.whenAttachSettled(10_000);
		},
		async call(scope, toolName, args = {}) {
			const definition = scope.runner.getToolDefinition(toolName);
			if (definition === undefined) throw new Error(`${toolName} is not registered`);
			calls += 1;
			// The scope's own tool context, listing the runtime's tools the way a session's callable set does.
			const context: ExtensionToolContext = Object.assign(scope.runner.createContext(), {
				tools: wrapRegisteredTools(scope.runner.getAllRegisteredTools(), scope.runner),
				executeTool: async () => {
					throw new Error("nested tool calls are not part of this harness");
				},
			});
			const result = await definition.execute(`call-${calls}`, args, undefined, undefined, context);
			const content: readonly { readonly type: string; readonly text?: string }[] = result.content;
			return content.map((part) => part.text ?? "").join("");
		},
		async dispose() {
			await service.dispose("quit");
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
