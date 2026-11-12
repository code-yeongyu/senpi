import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createMcpExtension } from "../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../src/core/extensions/builtin/mcp/service.ts";
import type { ExtensionAPI, LoadExtensionsResult } from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../src/modes/rpc/connection-handler.ts";
import type { RpcSkillInvocationEvent } from "../src/modes/rpc/rpc-types.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const MCP_INVENTORY_REQUEST_EVENT = "senpi.rpc.mcp_inventory.request";
const MCP_INVENTORY_CHANGED_EVENT = "senpi.rpc.mcp_inventory.changed";

type RpcRecord = Record<string, unknown>;
type McpSnapshot = {
	servers: Array<{
		name: string;
		serverInfo: {
			name: string;
			title: null;
			version: string;
			description: null;
			icons: null;
			websiteUrl: null;
		} | null;
		tools: Array<{ name: string; inputSchema: Record<string, never> }>;
		resources: [];
		resourceTemplates: [];
		authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
		status?: string;
	}>;
};

interface MutableResourceLoader extends ResourceLoader {
	readonly extensionsResult: LoadExtensionsResult;
	readonly skills: Skill[];
	mcpSnapshot: McpSnapshot;
}

interface Harness {
	runtimeHost: AgentSessionRuntime;
	resourceLoader: MutableResourceLoader;
	rebind: () => Promise<void>;
	cleanup: () => void;
}

interface CollectedSink {
	sink: RpcConnectionSink;
	messages: () => readonly RpcRecord[];
	waitFor: (predicate: (message: RpcRecord) => boolean, afterIndex?: number, timeoutMs?: number) => Promise<RpcRecord>;
}

function makeSink(): CollectedSink {
	const records: RpcRecord[] = [];
	const waiters: Array<{
		predicate: (message: RpcRecord) => boolean;
		afterIndex: number;
		resolve: (message: RpcRecord) => void;
	}> = [];
	let buffer = "";

	const dispatch = (record: RpcRecord) => {
		const index = records.push(record) - 1;
		for (const waiter of [...waiters]) {
			if (index < waiter.afterIndex || !waiter.predicate(record)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(record);
		}
	};

	return {
		sink: {
			writeRaw(chunk) {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) dispatch(JSON.parse(line) as RpcRecord);
					newline = buffer.indexOf("\n");
				}
			},
			waitForBackpressure: async () => {},
		},
		messages: () => records,
		waitFor(predicate, afterIndex = 0, timeoutMs = 1_000) {
			const existing = records.slice(afterIndex).find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				let waiter!: (typeof waiters)[number];
				const timer = setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index !== -1) waiters.splice(index, 1);
					reject(new Error("Timed out waiting for the expected RPC record"));
				}, timeoutMs);
				waiter = {
					predicate,
					afterIndex,
					resolve: (message) => {
						clearTimeout(timer);
						resolve(message);
					},
				};
				waiters.push(waiter);
			});
		},
	};
}

function sourceInfo(path: string, source = "local") {
	return { path, source, scope: "project" as const, origin: "top-level" as const };
}

function skill(name: string): Skill {
	const filePath = `/fixture/skills/${name}/SKILL.md`;
	return {
		name,
		description: `${name} skill`,
		filePath,
		baseDir: `/fixture/skills/${name}`,
		sourceInfo: sourceInfo(filePath),
		disableModelInvocation: false,
	};
}

function mcpServer(
	name: string,
	toolNames: string[],
	authStatus: McpSnapshot["servers"][number]["authStatus"],
	status: string,
): McpSnapshot["servers"][number] {
	return {
		name,
		serverInfo:
			status === "connected"
				? { name, title: null, version: "1.0.0", description: null, icons: null, websiteUrl: null }
				: null,
		tools: toolNames.map((toolName) => ({ name: toolName, inputSchema: {} })),
		resources: [],
		resourceTemplates: [],
		authStatus,
		status,
	};
}

async function makeHarness(tempDir: string): Promise<Harness> {
	const commandlessPath = join(tempDir, "commandless-extension.ts");
	const commandfulPath = join(tempDir, "commandful-extension.ts");
	const extensionsResult = await createTestExtensionsResult(
		[
			{ path: commandlessPath, factory: () => {} },
			{
				path: commandfulPath,
				factory: (pi: ExtensionAPI) => {
					pi.registerCommand("first", { handler: async () => {} });
					pi.registerCommand("second", { handler: async () => {} });
				},
			},
		],
		tempDir,
	);
	for (const extension of extensionsResult.extensions) {
		extension.sourceInfo = sourceInfo(extension.path);
	}
	const eventBus = createEventBus();
	const skills = [skill("alpha")];
	const resourceLoader: MutableResourceLoader = {
		extensionsResult,
		skills,
		mcpSnapshot: {
			servers: [
				mcpServer("connected-server", ["one", "two"], "bearerToken", "connected"),
				mcpServer("login-server", [], "notLoggedIn", "needs_auth"),
			],
		},
		getExtensions: () => extensionsResult,
		emitExtensionEvent: eventBus.emit,
		onExtensionEvent: eventBus.on,
		getSkills: () => ({ skills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	eventBus.on(MCP_INVENTORY_REQUEST_EVENT, (data) => {
		const request = data as {
			sessionId: string;
			respond: (snapshot: Promise<McpSnapshot>) => void;
		};
		request.respond(Promise.resolve(resourceLoader.mcpSnapshot));
	});

	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("model not found");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			throw new Error("RPC inventory tests must not call a model");
		},
	});
	const sessionManager = SessionManager.inMemory(tempDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, tempDir),
		resourceLoader,
	});
	let rebind: (() => Promise<void>) | undefined;
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn((callback: () => Promise<void>) => {
			rebind = callback;
		}),
	} as unknown as AgentSessionRuntime;
	return {
		runtimeHost,
		resourceLoader,
		rebind: async () => {
			if (!rebind) throw new Error("RPC handler did not register its rebind callback");
			await rebind();
		},
		cleanup: () => session.dispose(),
	};
}

describe("RPC loaded surfaces", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `rpc-loaded-surfaces-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns one loaded extension row per ResourceLoader extension, including commandless extensions", async () => {
		const collected = makeSink();
		const harness = await makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(JSON.stringify({ id: "surfaces", type: "get_loaded_surfaces" }));

		expect(await collected.waitFor((message) => message.id === "surfaces")).toMatchObject({
			type: "response",
			command: "get_loaded_surfaces",
			success: true,
			data: {
				extensions: [
					{
						name: "commandless-extension",
						path: join(tempDir, "commandless-extension.ts"),
						enabled: true,
						sourceInfo: sourceInfo(join(tempDir, "commandless-extension.ts")),
					},
					{
						name: "commandful-extension",
						path: join(tempDir, "commandful-extension.ts"),
						enabled: true,
					},
				],
				mcpServers: [
					{ name: "connected-server", toolCount: 2, authStatus: "bearerToken", status: "connected" },
					{ name: "login-server", toolCount: 0, authStatus: "notLoggedIn", status: "needs_auth" },
				],
			},
		});
		await handler.dispose();
	});

	it("reads configured MCP servers from the session-owned live service bridge", async () => {
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			`${JSON.stringify({
				mcpServers: {
					"configured-disabled": { type: "stdio", command: "unused", enabled: false },
				},
			})}\n`,
		);
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
			extensionFactories: [{ name: "mcp-control-test", factory: createMcpExtension(service) }],
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
					throw new Error("RPC inventory tests must not call a model");
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
		const collected = makeSink();
		const handler = createRpcConnectionHandler(runtimeHost, collected.sink);
		try {
			await handler.handleInputLine(JSON.stringify({ id: "live-mcp", type: "get_loaded_surfaces" }));
			expect(await collected.waitFor((message) => message.id === "live-mcp")).toMatchObject({
				success: true,
				data: {
					mcpServers: [
						{
							name: "configured-disabled",
							toolCount: 0,
							status: "disabled",
							authStatus: "unsupported",
						},
					],
				},
			});
		} finally {
			await handler.dispose();
			session.dispose();
			await service.dispose("quit");
			vi.unstubAllEnvs();
		}
	});

	it("emits loaded_surfaces_changed for skill, extension, and MCP inventory transitions but not initial bind", async () => {
		const collected = makeSink();
		const harness = await makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		await handler.ready;
		expect(collected.messages().filter((message) => message.type === "loaded_surfaces_changed")).toEqual([]);

		let afterIndex = collected.messages().length;
		const skillChanged = collected.waitFor((message) => message.type === "loaded_surfaces_changed", afterIndex);
		harness.resourceLoader.skills.push(skill("beta"));
		await harness.rebind();
		expect(await skillChanged).toEqual({ type: "loaded_surfaces_changed" });

		afterIndex = collected.messages().length;
		const extensionChanged = collected.waitFor((message) => message.type === "loaded_surfaces_changed", afterIndex);
		harness.resourceLoader.extensionsResult.extensions.push(
			(
				await createTestExtensionsResult(
					[{ path: join(tempDir, "later-commandless.ts"), factory: () => {} }],
					tempDir,
				)
			).extensions[0]!,
		);
		await harness.rebind();
		expect(await extensionChanged).toEqual({ type: "loaded_surfaces_changed" });

		afterIndex = collected.messages().length;
		const mcpChanged = collected.waitFor((message) => message.type === "loaded_surfaces_changed", afterIndex);
		harness.resourceLoader.mcpSnapshot = {
			servers: [mcpServer("connected-server", ["one", "two", "three"], "oAuth", "connected")],
		};
		harness.resourceLoader.emitExtensionEvent?.(MCP_INVENTORY_CHANGED_EVENT, {
			sessionId: harness.runtimeHost.session.sessionId,
			snapshot: harness.resourceLoader.mcpSnapshot,
		});
		expect(await mcpChanged).toEqual({ type: "loaded_surfaces_changed" });

		await handler.dispose();
	});

	it("forwards skill_invocation without disturbing the revealed MCP inventory", async () => {
		const collected = makeSink();
		const harness = await makeHarness(tempDir);
		cleanup = harness.cleanup;
		const skillPath = join(tempDir, "skill-alpha.md");
		writeFileSync(skillPath, "# Alpha\n\nUse the alpha skill.");
		harness.resourceLoader.skills[0] = {
			...harness.resourceLoader.skills[0]!,
			filePath: skillPath,
			baseDir: tempDir,
		};
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		await handler.ready;

		await handler.handleInputLine(JSON.stringify({ id: "before", type: "get_loaded_surfaces" }));
		const before = await collected.waitFor((message) => message.id === "before");

		const afterIndex = collected.messages().length;
		const invocationPromise = collected.waitFor((message) => message.type === "skill_invocation", afterIndex);
		await harness.runtimeHost.session.steer("$skill:alpha inspect").catch(() => {});
		const expectedInvocation = {
			type: "skill_invocation",
			skills: [{ name: "alpha", path: skillPath, syntax: "dollar" }],
		} satisfies RpcSkillInvocationEvent;
		expect(await invocationPromise).toEqual(expectedInvocation);

		await handler.handleInputLine(JSON.stringify({ id: "after", type: "get_loaded_surfaces" }));
		const after = await collected.waitFor((message) => message.id === "after");
		expect(after.data).toEqual(before.data);

		await handler.dispose();
	});
});
