import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../src/config.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createAppServerRuntime } from "../../src/modes/app-server/index.ts";
import {
	createMcpWireStatusAdapter,
	createMcpWireStatusRegistry,
	type McpWireStatusServer,
} from "../../src/modes/app-server/threads/mcp-wire-status.ts";
import { ThreadRegistry, type ThreadRegistryOptions } from "../../src/modes/app-server/threads/registry.ts";

describe("app-server MCP wire-status adapter", () => {
	it("captures distinct attach scopes from the MCP service before the global service is reused", async () => {
		// Given: two isolated session config directories with different disabled servers.
		const firstRoot = await makeMcpRoot("first");
		const secondRoot = await makeMcpRoot("second");
		const service = getMcpService();
		try {
			await writeMcpConfig(firstRoot, "first-server");
			await writeMcpConfig(secondRoot, "second-server");

			// When: the same process service attaches both session scopes in sequence.
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				attachContext(firstRoot, "thread-first"),
				undefined,
				{ agentDir: firstRoot, projectTrusted: true },
			);
			await service.attachSession(
				{ type: "session_start", reason: "new" },
				attachContext(secondRoot, "thread-second"),
				undefined,
				{ agentDir: secondRoot, projectTrusted: true },
			);

			const first = createMcpWireStatusAdapter(service.getWireStatusSnapshot("thread-first"));
			const second = createMcpWireStatusAdapter(service.getWireStatusSnapshot("thread-second"));

			// Then: each adapter retains only the state captured for its own session.
			expect(first.getServerStatuses().map((server) => server.name)).toEqual(["first-server"]);
			expect(second.getServerStatuses().map((server) => server.name)).toEqual(["second-server"]);
		} finally {
			await service.dispose("quit");
			resetMcpServiceForTests();
			await rm(firstRoot, { recursive: true, force: true });
			await rm(secondRoot, { recursive: true, force: true });
		}
	});

	it("captures distinct attach scopes when app-server sessions attach concurrently", async () => {
		// Given: two isolated app-server sessions with different disabled MCP fixtures.
		const firstRoot = await makeMcpRoot("concurrent-first");
		const secondRoot = await makeMcpRoot("concurrent-second");
		const service = getMcpService();
		try {
			await Promise.all([
				writeMcpConfig(firstRoot, "concurrent-first-server"),
				writeMcpConfig(secondRoot, "concurrent-second-server"),
			]);

			// When: both sessions attach through the real process singleton at the same time.
			await Promise.all([
				service.attachSession(
					{ type: "session_start", reason: "startup" },
					attachContext(firstRoot, "concurrent-thread-first"),
					undefined,
					{ agentDir: firstRoot, projectTrusted: true },
				),
				service.attachSession(
					{ type: "session_start", reason: "new" },
					attachContext(secondRoot, "concurrent-thread-second"),
					undefined,
					{ agentDir: secondRoot, projectTrusted: true },
				),
			]);

			// Then: each session id retains the inventory loaded from its own fixture.
			expect(service.getWireStatusSnapshot("concurrent-thread-first").servers.map((server) => server.name)).toEqual([
				"concurrent-first-server",
			]);
			expect(service.getWireStatusSnapshot("concurrent-thread-second").servers.map((server) => server.name)).toEqual(
				["concurrent-second-server"],
			);
		} finally {
			await service.dispose("quit");
			resetMcpServiceForTests();
			await rm(firstRoot, { recursive: true, force: true });
			await rm(secondRoot, { recursive: true, force: true });
		}
	});

	it("keeps two loaded thread inventories isolated and preserves configured unconnected servers", () => {
		// Given: two sessions with different MCP attach inventories and a process-scope fallback.
		const threadA = createMcpWireStatusAdapter({
			servers: [connectedServer("alpha", "bearerToken"), unconnectedServer("alpha-login", "notLoggedIn")],
		});
		const threadB = createMcpWireStatusAdapter({
			servers: [connectedServer("beta", "oAuth")],
		});
		const global = createMcpWireStatusAdapter({
			servers: [connectedServer("global", "unsupported")],
		});
		const registry = createMcpWireStatusRegistry(global);
		registry.registerThread("thread-a", threadA);
		registry.registerThread("thread-b", threadB);

		// When: each scope is resolved through the per-session registry.
		const resolvedA = registry.resolve("thread-a");
		const resolvedB = registry.resolve("thread-b");
		const resolvedGlobal = registry.resolve();

		// Then: thread A sees only its own configured and connected servers.
		if (!resolvedA || !resolvedB || !resolvedGlobal) throw new Error("MCP adapter scope was not registered");
		expect(resolvedA.getServerStatuses().map((server) => server.name)).toEqual(["alpha", "alpha-login"]);
		expect(resolvedA.getServerStatuses()[0]).toMatchObject({
			name: "alpha",
			authStatus: "bearerToken",
			serverInfo: { name: "alpha", version: "1.0.0" },
			tools: { search: { name: "search" } },
			resources: [{ name: "alpha-resource", uri: "alpha://resource" }],
			resourceTemplates: [{ name: "alpha-template", uriTemplate: "alpha://{id}" }],
		});
		expect(resolvedA.getServerStatuses()[1]).toMatchObject({
			name: "alpha-login",
			serverInfo: null,
			tools: {},
			resources: [],
			resourceTemplates: [],
			authStatus: "notLoggedIn",
		});

		// Then: thread B and the threadless fallback cannot observe thread A's state.
		expect(resolvedB.getServerStatuses().map((server) => server.name)).toEqual(["beta"]);
		expect(resolvedB.getServerStatuses()[0]?.authStatus).toBe("oAuth");
		expect(resolvedGlobal.getServerStatuses().map((server) => server.name)).toEqual(["global"]);
		expect(registry.resolve("missing-thread")).toBeUndefined();
	});

	it("resolves a configured global adapter for threadless production registry lookup without leaking loaded threads", async () => {
		// Given: a production ThreadRegistry creates two loaded threads with distinct MCP inventories.
		const root = await makeMcpRoot("threadless-registry");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		const first = createMcpWireStatusAdapter({ servers: [connectedServer("thread-first", "bearerToken")] });
		const second = createMcpWireStatusAdapter({ servers: [connectedServer("thread-second", "oAuth")] });
		const global = createMcpWireStatusAdapter({ servers: [connectedServer("global-configured", "unsupported")] });
		const adaptersByCwd = new Map([
			[firstCwd, first],
			[secondCwd, second],
		]);
		const createSession: ThreadRegistryOptions["createSession"] = async (options) => {
			const adapter = options.cwd === undefined ? undefined : adaptersByCwd.get(options.cwd);
			if (adapter === undefined) throw new Error(`Missing MCP test adapter for ${options.cwd ?? "<unset cwd>"}`);
			const result = await createAgentSession({ ...options, autoTitleSessions: false });
			return { ...result, mcpWireStatusAdapter: adapter };
		};
		const registryOptions = {
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
			createSession,
			mcpWireStatusAdapter: global,
		};
		const registry = new ThreadRegistry(registryOptions);
		try {
			await mkdir(firstCwd, { recursive: true });
			await mkdir(secondCwd, { recursive: true });

			// When: loaded thread IDs and the threadless scope are resolved through the production registry.
			const firstEntry = await registry.createThread({ cwd: firstCwd });
			const secondEntry = await registry.createThread({ cwd: secondCwd });
			const resolvedFirst = registry.getMcpWireStatusAdapter(firstEntry.id);
			const resolvedSecond = registry.getMcpWireStatusAdapter(secondEntry.id);
			const resolvedGlobal = registry.getMcpWireStatusAdapter();

			// Then: each loaded thread remains isolated, and the threadless lookup uses the configured global adapter.
			expect(resolvedFirst?.getServerStatuses().map((server) => server.name)).toEqual(["thread-first"]);
			expect(resolvedSecond?.getServerStatuses().map((server) => server.name)).toEqual(["thread-second"]);
			expect(resolvedGlobal?.getServerStatuses().map((server) => server.name)).toEqual(["global-configured"]);
		} finally {
			for (const thread of registry.listLoaded()) registry.unloadThread(thread.id);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("builds the runtime process adapter from process-level MCP config", async () => {
		// Given: the real app-server runtime starts with its explicit process-scope adapter.
		const root = await makeMcpRoot("runtime-global");
		const sessionDir = join(root, "sessions");
		resetMcpServiceForTests();
		vi.stubEnv(ENV_AGENT_DIR, root);
		vi.stubEnv(ENV_SESSION_DIR, sessionDir);
		await writeMcpConfig(root, "global-configured");
		await writeProjectMcpConfig(root, "session-only-server");
		const runtime = createAppServerRuntime(() => {});
		let threadId: string | undefined;
		try {
			const processAdapter = runtime.threads.getMcpWireStatusAdapter();
			if (processAdapter === undefined) throw new Error("App-server runtime did not create a process MCP adapter");
			expect(processAdapter.getServerStatuses().map((server) => server.name)).toEqual(["global-configured"]);

			// When: an app-server thread binds extensions and captures its session inventory.
			const entry = await runtime.threads.createThread({ cwd: root });
			threadId = entry.id;

			// Then: the thread sees its own server without replacing the process-scope fallback.
			expect(
				runtime.threads
					.getMcpWireStatusAdapter(threadId)
					?.getServerStatuses()
					.map((server) => server.name),
			).toEqual(["global-configured", "session-only-server"]);
			expect(
				runtime.threads
					.getMcpWireStatusAdapter()
					?.getServerStatuses()
					.map((server) => server.name),
			).toEqual(["global-configured"]);
		} finally {
			if (threadId !== undefined) runtime.threads.unloadThread(threadId);
			runtime.dispose();
			await getMcpService().dispose("quit");
			resetMcpServiceForTests();
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
		}
	});
});

async function makeMcpRoot(name: string): Promise<string> {
	return await mkdtemp(join(tmpdir(), `senpi-mcp-wire-${name}-`));
}

async function writeMcpConfig(root: string, serverName: string): Promise<void> {
	await writeFile(
		join(root, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				[serverName]: { type: "stdio", command: "unused", enabled: false },
			},
		}),
	);
}

async function writeProjectMcpConfig(root: string, serverName: string): Promise<void> {
	const projectConfigDir = join(root, CONFIG_DIR_NAME);
	await mkdir(projectConfigDir, { recursive: true });
	await writeFile(
		join(projectConfigDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				[serverName]: { type: "stdio", command: "unused", enabled: false },
			},
		}),
	);
}

function attachContext(root: string, sessionId: string) {
	return {
		cwd: root,
		mode: "app-server" as const,
		isProjectTrusted: () => true,
		sessionManager: { getEntries: () => [], getSessionId: () => sessionId },
	};
}

function connectedServer(name: string, authStatus: McpWireStatusServer["authStatus"]): McpWireStatusServer {
	return {
		name,
		serverInfo: {
			name,
			title: null,
			version: "1.0.0",
			description: null,
			icons: null,
			websiteUrl: null,
		},
		tools: [
			{
				name: "search",
				inputSchema: { type: "object" },
			},
		],
		resources: [{ name: `${name}-resource`, uri: `${name}://resource` }],
		resourceTemplates: [{ name: `${name}-template`, uriTemplate: `${name}://{id}` }],
		authStatus,
	};
}

function unconnectedServer(name: string, authStatus: McpWireStatusServer["authStatus"]): McpWireStatusServer {
	return {
		name,
		serverInfo: null,
		tools: [],
		resources: [],
		resourceTemplates: [],
		authStatus,
	};
}
