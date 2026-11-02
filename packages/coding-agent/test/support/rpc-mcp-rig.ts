import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../../src/modes/rpc/connection-handler.ts";
import { bounded } from "../mcp/fixtures/gated-http-server.ts";

// One RPC connection over a real AgentSession whose only extension is the builtin MCP extension on a private service,
// configured from `servers` in a temporary agent dir.

export type RpcRecord = Record<string, unknown>;

export interface CollectedSink {
	readonly sink: RpcConnectionSink;
	readonly records: RpcRecord[];
	waitFor(predicate: (record: RpcRecord) => boolean, label: string): Promise<RpcRecord>;
}

function collectSink(): CollectedSink {
	const records: RpcRecord[] = [];
	const waiters = new Set<{ predicate: (record: RpcRecord) => boolean; resolve: (record: RpcRecord) => void }>();
	let buffer = "";
	return {
		records,
		sink: {
			writeRaw(chunk) {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) {
						const record = JSON.parse(line) as RpcRecord;
						records.push(record);
						for (const waiter of [...waiters]) {
							if (!waiter.predicate(record)) continue;
							waiters.delete(waiter);
							waiter.resolve(record);
						}
					}
					newline = buffer.indexOf("\n");
				}
			},
			waitForBackpressure: async () => {},
		},
		waitFor(predicate, label) {
			const existing = records.find(predicate);
			if (existing !== undefined) return Promise.resolve(existing);
			return bounded(
				new Promise<RpcRecord>((resolve) => {
					waiters.add({ predicate, resolve });
				}),
				label,
			);
		},
	};
}

export interface Rig {
	readonly service: McpService;
	readonly session: AgentSession;
	readonly collected: CollectedSink;
	readonly handler: ReturnType<typeof createRpcConnectionHandler>;
	request(type: string): Promise<RpcRecord>;
	surfaceEvents(): number;
	nextRegistration(): Promise<void>;
	dispose(): Promise<void>;
}

export async function startRig(root: string, servers: Record<string, unknown>): Promise<Rig> {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: servers })}\n`);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	const service = new McpService();
	const settingsManager = SettingsManager.inMemory({ enabledBuiltinExtensions: [] });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [{ name: "mcp-startup-surfaces", factory: createMcpExtension(service) }],
	});
	await resourceLoader.reload();
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("model not found");
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("startup surface tests must not call a model");
			},
		}),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
		cwd,
		modelRegistry: ModelRegistry.create(authStorage, agentDir),
		resourceLoader,
	});
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
	const collected = collectSink();
	const handler = createRpcConnectionHandler(runtimeHost, collected.sink);
	let requests = 0;
	return {
		service,
		session,
		collected,
		handler,
		async request(type) {
			const id = `${type}-${++requests}`;
			await handler.handleInputLine(JSON.stringify({ id, type }));
			return collected.waitFor((record) => record.id === id, `${type} response`);
		},
		surfaceEvents: () => collected.records.filter((record) => record.type === "loaded_surfaces_changed").length,
		nextRegistration() {
			return new Promise<void>((resolve) => {
				const unsubscribe = service.onMcpRegistrationChanged(() => {
					unsubscribe();
					resolve();
				});
			});
		},
		async dispose() {
			await handler.dispose();
			session.dispose();
			await service.dispose("quit");
		},
	};
}
