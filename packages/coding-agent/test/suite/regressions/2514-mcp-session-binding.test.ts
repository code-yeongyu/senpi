// Regression: senpi#2514. Sessions outside the RPC host share one MCP service and its server
// connections, yet each session must keep its own binding: its own session ref and tool-search
// service, never the binding of whichever session attached last.

import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { getMcpCatalogCachePath } from "../../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import mcpExtension from "../../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { parseSkillMcpDeclarations, type SkillLike } from "../../../src/core/extensions/builtin/mcp/skills.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../../src/core/extensions/builtin/mcp/startup-race.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import { getToolSearchService } from "../../../src/core/extensions/builtin/tool-search/service.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { ExtensionAPI, LoadExtensionsResult } from "../../../src/index.ts";
import { createUi } from "../../mcp/fixtures/commands.ts";
import { type CapturingPi, capturingPi, registeredTool } from "../../mcp/fixtures/register-call.ts";
import {
	assertAlive,
	cleanupRoots,
	makeRoot,
	readCounter,
	requiredPid,
	setConfig,
	stdioServer,
	type TestRoot,
	writeProjectConfig,
} from "../../mcp/fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "../../mcp/fixtures/sharing-http.ts";
import { assertProcessDead, stdioFixtureCommand } from "../../mcp/fixtures/spawn-fixture.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const TOOL = "mcp_fx_tool_1";
const EXTRA_TOOL = "mcp_extra_tool_1";
const REGISTRATION_TIMEOUT_MS = 8_000;

const cleanupTasks: Array<() => Promise<void>> = [];
const open = new Set<Harness>();
const scopes: ProviderScope[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
let root: TestRoot;
let spawnCounter: string;
let catalogGate: string;

function configureServer(extraArgs: readonly string[] = []): void {
	setConfig(root, {
		fx: {
			...stdioServer(["--tools", "2", "--spawn-counter-file", spawnCounter, ...extraArgs]),
			exposure: "search",
			lifecycle: "eager",
		},
	});
}

function configureGatedServer(): void {
	// A zero startup window backgrounds every connect, so the gated catalog lands after both sessions attached.
	vi.stubEnv(MCP_STARTUP_TIMEOUT_ENV, "0");
	configureServer(["--list-tools-gate", catalogGate]);
}

function releaseCatalog(): void {
	writeFileSync(catalogGate, "");
}

/** Declare the `extra` server from a session's own extensions, so only that session's config has it. */
function registerExtraServer(pi: ExtensionAPI): void {
	const fixture = stdioFixtureCommand();
	pi.registerMcpServer("extra", {
		type: "stdio",
		command: fixture.command,
		args: [...fixture.args, "--tools", "1"],
		exposure: "search",
		lifecycle: "eager",
	});
}

function mcpExtensions(onLoad: (pi: ExtensionAPI) => void = () => {}): Promise<LoadExtensionsResult> {
	return createTestExtensionsResult([
		{ path: "<builtin:tool-search>", factory: toolSearchExtension },
		{ path: "<builtin:mcp>", factory: mcpExtension },
		{ path: "/extensions/probe.ts", factory: onLoad },
	]);
}

function reloadableLoader(initial: LoadExtensionsResult): ResourceLoader {
	let current = initial;
	return {
		...createTestResourceLoader(),
		getExtensions: () => current,
		reload: async () => {
			current = await mcpExtensions();
		},
	};
}

async function openSession(extensionsResult?: LoadExtensionsResult): Promise<Harness> {
	const harness = await createHarness({
		resourceLoader: reloadableLoader(extensionsResult ?? (await mcpExtensions())),
	});
	open.add(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

function close(harness: Harness): void {
	open.delete(harness);
	harness.cleanup();
}

async function shutDown(harness: Harness, reason: "quit" | "new"): Promise<void> {
	await harness.getExtensionRunner().emit({ type: "session_shutdown", reason });
	close(harness);
}

async function reload(harness: Harness): Promise<void> {
	await harness.session.reload();
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "reload" });
}

function registeredNames(harness: Harness): string[] {
	return harness.session.getAllTools().map(({ name }) => name);
}

function untilToolRegistered(harness: Harness, name: string): Promise<void> {
	const service = getMcpService();
	return new Promise((resolve, reject) => {
		if (registeredNames(harness).includes(name)) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`${name} never registered in session ${harness.session.sessionId}`));
		}, REGISTRATION_TIMEOUT_MS);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			if (!registeredNames(harness).includes(name)) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

async function callMcpTool(harness: Harness, value: string, tool = TOOL): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(tool, { value }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt(`call ${tool}`);
	const result = harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.findLast((message) => message.role === "toolResult" && message.toolName === tool);
	if (result === undefined) throw new Error(`no ${tool} result in session ${harness.session.sessionId}`);
	return getMessageText(result);
}

beforeEach(() => {
	resetMcpServiceForTests();
	root = makeRoot("2514-session-binding", cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	spawnCounter = join(root.agentDir, "spawns.txt");
	catalogGate = join(root.agentDir, "catalog-gate");
});

afterEach(async () => {
	// Quit every session still open, so a session-owned (provider-scoped) service is disposed even
	// when its test failed before its own shutdown.
	for (const harness of [...open]) await shutDown(harness, "quit");
	for (const scope of scopes.splice(0)) scope.close();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	vi.unstubAllEnvs();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	await cleanupRoots(cleanupTasks);
});

describe("senpi#2514: each session binds its own view of the shared MCP service", () => {
	it(
		"keeps classic parent MCP ownership across a builtin-only SDK child's lifecycle",
		async () => {
			// Given: the parent uses a common server and its own extension declaration.
			setConfig(root, {
				fx: {
					...stdioServer(["--tools", "2", "--spawn-counter-file", spawnCounter]),
					exposure: "direct",
					lifecycle: "eager",
				},
			});
			const parentOnlyTool = "mcp_parent_only_tool_1";
			const parent = await openSession(
				await mcpExtensions((pi) =>
					pi.registerMcpServer("parent_only", { ...stdioServer(["--tools", "1"]), exposure: "direct" }),
				),
			);
			await untilToolRegistered(parent, TOOL);
			await untilToolRegistered(parent, parentOnlyTool);
			const service = getMcpService();
			await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);
			const connection = service.getConnection("fx");
			const pid = connection?.getRootPid();
			const generation = connection?.generation;
			const retained = parent.session.agent.state.tools.find((tool) => tool.name === TOOL);
			if (retained === undefined) throw new Error("Parent MCP tool was not registered");
			const parentValue = "parent-survives";
			const assertParent = async () => {
				for (const name of [TOOL, parentOnlyTool]) {
					const result = await parent.session.executeTool(name, { value: parentValue });
					expect(result).not.toHaveProperty("details.error");
					expect(getMessageText(result)).toContain(`fixture tool_1 value=${parentValue}`);
				}
				const offeredResult = await retained.execute("retained-parent", { value: parentValue });
				expect(offeredResult).not.toHaveProperty("details.error");
				expect(getMessageText(offeredResult)).toContain(`fixture tool_1 value=${parentValue}`);
				expect(service.getConnection("fx")?.getRootPid()).toBe(pid);
				expect(service.getConnection("fx")?.generation).toBe(generation);
			};
			await assertParent();

			// When: a real builtin-only loader loads before SDK session creation, outside a provider scope.
			let registered = Promise.withResolvers<void>();
			const settingsManager = SettingsManager.create(root.cwd, root.agentDir);
			const childLoader = new DefaultResourceLoader({
				cwd: root.cwd,
				agentDir: root.agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					{
						name: "child-registration",
						factory: (pi) => {
							pi.on("tool_activated", (event) => {
								if (event.toolNames.includes(TOOL)) registered.resolve();
							});
						},
					},
				],
			});
			await childLoader.reload();
			const { session: child } = await createAgentSession({
				cwd: root.cwd,
				agentDir: root.agentDir,
				settingsManager,
				resourceLoader: childLoader,
				model: parent.getModel(),
				sessionManager: SessionManager.inMemory(root.cwd),
			});
			try {
				await child.bindExtensions({
					mode: "print",
					onError: ({ error }) => {
						throw new Error(error);
					},
				});
				await registered.promise;

				// Then: the child neither inherits the parent's server nor changes its offered tools or connection.
				expect(child.getToolDefinition(parentOnlyTool)).toBeUndefined();
				const childValue = "child-private";
				expect(getMessageText(await child.executeTool(TOOL, { value: childValue }))).toContain(
					`fixture tool_1 value=${childValue}`,
				);
				await assertParent();
				registered = Promise.withResolvers<void>();
				await child.reload();
				await registered.promise;
				expect(getMessageText(await child.executeTool(TOOL, { value: childValue }))).toContain(
					`fixture tool_1 value=${childValue}`,
				);
				await assertParent();
			} finally {
				await child.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				child.dispose();
			}
			await assertParent();
			// The one shared `fx` process served the parent and the child across its attach, reload and quit.
			expect(await readCounter(spawnCounter)).toBe(1);
		},
		REGISTRATION_TIMEOUT_MS,
	);

	it("shares one server process, yet lands and activates MCP tools in each session's own tool set", async () => {
		// Given: two live sessions attach while the shared server's catalog is still loading.
		configureGatedServer();
		const alpha = await openSession();
		const bravo = await openSession();

		// When: the catalog lands, and the model in the first session calls an MCP tool by name.
		releaseCatalog();
		await untilToolRegistered(alpha, TOOL);
		await untilToolRegistered(bravo, TOOL);
		const result = await callMcpTool(alpha, "from-alpha");

		// Then: one server process serves both, and the activation stays in the session that made it.
		expect(result).toContain("fixture tool_1 value=from-alpha");
		expect(await readCounter(spawnCounter)).toBe(1);
		expect(alpha.session.getActiveToolNames()).toContain(TOOL);
		expect(bravo.session.getActiveToolNames()).not.toContain(TOOL);
		expect(registeredNames(bravo)).toContain(TOOL);
	});

	it("keeps the other session's MCP tools resolving and activating after a session reloads and is replaced", async () => {
		// Given: two live sessions attach while the catalog loads; the second reloads, then is replaced.
		configureGatedServer();
		let alphaApi: ExtensionAPI | undefined;
		const alpha = await openSession(
			await mcpExtensions((pi) => {
				alphaApi = pi;
			}),
		);
		const bravo = await openSession();
		await reload(bravo);
		await shutDown(bravo, "new");

		// When: the catalog lands, and the remaining session calls the MCP tool by name. The call goes
		// through the session's own executeTool: a reload resets the process-wide API providers, which
		// unregisters this harness's faux model.
		releaseCatalog();
		await untilToolRegistered(alpha, TOOL);
		const outcome = await alphaApi?.executeTool(TOOL, { value: "after-replacement" }, { activateInactiveTool: true });
		const result = outcome?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";

		// Then: the call resolves and activates in the remaining session, with no stale-context failure.
		expect(result).toContain("fixture tool_1 value=after-replacement");
		expect(result).not.toMatch(/stale|disposed/);
		expect(alpha.session.getActiveToolNames()).toContain(TOOL);
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("keeps the shared connection serving the remaining session when another session quits", async () => {
		// Given: two live sessions with the shared server connected and its tools registered in both.
		configureServer();
		const alpha = await openSession();
		await untilToolRegistered(alpha, TOOL);
		const bravo = await openSession();
		await untilToolRegistered(bravo, TOOL);
		const service = getMcpService();
		const connection = service.getConnection("fx");
		const pid = connection?.getRootPid();
		const generation = connection?.generation;

		// When: the second session quits the way a closed session does, and the first calls the MCP tool.
		await shutDown(bravo, "quit");
		const result = await callMcpTool(alpha, "after-quit");

		// Then: the call succeeds on the same process and connection generation: no re-spawn, no reconnect.
		expect(result).toContain("fixture tool_1 value=after-quit");
		expect(getMcpService()).toBe(service);
		expect(service.isDisposed()).toBe(false);
		expect(service.getConnection("fx")?.getRootPid()).toBe(pid);
		expect(service.getConnection("fx")?.generation).toBe(generation);
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("keeps a session's MCP tools working after a peer session with a different MCP config attaches (senpi#2597)", async () => {
		// Given: the first session's extensions declare an extra MCP server, so its resolved config differs from a
		// peer that loads without them (an OmO memory sidecar beside the main session), and both declare `fx`.
		configureServer();
		const alpha = await openSession(await mcpExtensions(registerExtraServer));
		await untilToolRegistered(alpha, TOOL);
		await untilToolRegistered(alpha, EXTRA_TOOL);

		// When: the peer attaches to the shared service, then the first session calls both servers' tools.
		const bravo = await openSession();
		await untilToolRegistered(bravo, TOOL);
		const shared = await callMcpTool(alpha, "after-peer");
		const extra = await callMcpTool(alpha, "extra-after-peer", EXTRA_TOOL);

		// Then: the peer's attach neither retired the first session's tools nor tore down the server only it declares.
		expect(shared).toContain("fixture tool_1 value=after-peer");
		expect(extra).toContain("fixture tool_1 value=extra-after-peer");
		expect(registeredNames(bravo)).not.toContain(EXTRA_TOOL);
		expect(await callMcpTool(bravo, "from-bravo")).toContain("fixture tool_1 value=from-bravo");
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("stops a server only a released session declared, while the peer keeps its shared server (senpi#2597)", async () => {
		// Given: the first session alone declares `extra`, and a peer that declares only `fx` attaches after it.
		configureServer();
		const alpha = await openSession(await mcpExtensions(registerExtraServer));
		await untilToolRegistered(alpha, EXTRA_TOOL);
		const bravo = await openSession();
		await untilToolRegistered(bravo, TOOL);
		const service = getMcpService();
		const extraPid = requiredPid(service, "extra");

		// When: the session that declared `extra` quits while the peer stays live.
		await shutDown(alpha, "quit");

		// Then: the server no live session declares is stopped, and the peer's shared server serves on, unrestarted.
		await assertProcessDead(extraPid);
		expect(service.getConnection("extra")).toBeUndefined();
		expect(await callMcpTool(bravo, "after-release")).toContain("fixture tool_1 value=after-release");
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("still gives a provider-scoped (RPC host) session its own service, apart from the shared one", async () => {
		// Given: a classic session on the shared service, and a session loaded inside a provider scope.
		configureServer();
		const classic = await openSession();
		await untilToolRegistered(classic, TOOL);
		const shared = getMcpService();
		const scope = new ProviderScope();
		scopes.push(scope);
		const scopedExtensions = await runWithProviderScope(scope, () => mcpExtensions());
		const scoped = await openSession(scopedExtensions);
		const scopedResult = await callMcpTool(scoped, "scoped");

		// When: the provider-scoped session quits.
		await shutDown(scoped, "quit");
		const result = await callMcpTool(classic, "after-scoped-quit");

		// Then: it ran its own server process and never attached to the shared service, which keeps serving.
		expect(scopedResult).toContain("fixture tool_1 value=scoped");
		expect(await readCounter(spawnCounter)).toBe(2);
		expect(shared.getSnapshot()).toMatchObject({ disposed: false, sessionStartCount: 1 });
		expect(result).toContain("fixture tool_1 value=after-scoped-quit");
	});
});

async function attachFake(pi: CapturingPi): Promise<void> {
	await getMcpService().attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true },
		pi,
		{ agentDir: root.agentDir },
	);
}

function untilFakeRegistered(pi: CapturingPi, name: string): Promise<void> {
	const service = getMcpService();
	return new Promise((resolve, reject) => {
		if (pi.registeredTools.includes(name)) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`${name} never registered`));
		}, REGISTRATION_TIMEOUT_MS);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			if (!pi.registeredTools.includes(name)) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

function nextRegistration(): Promise<void> {
	const service = getMcpService();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error("no MCP registration"));
		}, REGISTRATION_TIMEOUT_MS);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

async function httpServer(): Promise<Awaited<ReturnType<typeof sharingHttpFixture>>> {
	const fixture = await sharingHttpFixture();
	cleanupTasks.push(() => fixture.close());
	setConfig(root, { fx: { type: "http", url: fixture.url, auth: false, lifecycle: "eager" } });
	return fixture;
}

/** Attach two sessions to the http server, then drain the connect's own refresh so later refreshes are the test's. */
async function twoHttpSessions(): Promise<{ alphaPi: CapturingPi; bravoPi: CapturingPi }> {
	const alphaPi = capturingPi();
	const bravoPi = capturingPi();
	await attachFake(alphaPi);
	await attachFake(bravoPi);
	await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
	const drained = nextRegistration();
	getMcpService().getConnection("fx")?.markToolsChanged();
	await drained;
	await untilFakeRegistered(alphaPi, "mcp_fx_echo");
	await untilFakeRegistered(bravoPi, "mcp_fx_echo");
	return { alphaPi, bravoPi };
}

describe("senpi#2514: the shared service keeps sessions apart under concurrency and failure", () => {
	it("gives each session without its own tool-search service a separate fallback service", async () => {
		// Given: two sessions whose extension loads own no tool-search service attach to the shared service.
		configureServer();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		const alphaSearch = getToolSearchService({
			getAllTools: () => [],
			getActiveTools: () => alphaPi.getActiveTools(),
			setActiveTools: (names) => alphaPi.setActiveTools([...names]),
		});
		await attachFake(alphaPi);
		await untilFakeRegistered(alphaPi, TOOL);
		await attachFake(bravoPi);
		await untilFakeRegistered(bravoPi, TOOL);

		// When: the first session's tool search activates an MCP tool.
		const activated = alphaSearch.activateTool(TOOL);

		// Then: the tool is active in that session only.
		expect(activated).toBe(true);
		expect(alphaPi.getActiveTools()).toContain(TOOL);
		expect(bravoPi.getActiveTools()).not.toContain(TOOL);
	});

	it("keeps the shared service alive for a session whose attach is queued when the last bound session quits", async () => {
		// Given: one bound session with the server connected.
		configureServer();
		const service = getMcpService();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await untilFakeRegistered(alphaPi, TOOL);
		const pid = service.getConnection("fx")?.getRootPid();

		// When: a second session's attach is queued, and the first quits before it binds.
		const bravoPi = capturingPi();
		const bravoAttach = attachFake(bravoPi);
		await service.releaseSession(alphaPi, "quit");
		await bravoAttach;

		// Then: the queued session binds to the live service on the same server process, and its own quit cleans up.
		expect(service.isDisposed()).toBe(false);
		expect(bravoPi.registeredTools).toContain(TOOL);
		expect(service.getConnection("fx")?.getRootPid()).toBe(pid);
		await service.releaseSession(bravoPi, "quit");
		expect(service.getSnapshot()).toMatchObject({ disposed: true, connectionCount: 0 });
		if (pid !== null && pid !== undefined) await assertProcessDead(pid);
	});

	it("refuses a session's earlier MCP tool once that session's own server configuration changes", async () => {
		// Given: a session whose `fx` tool is registered.
		configureServer();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await untilFakeRegistered(alphaPi, TOOL);
		const stale = registeredTool(alphaPi, TOOL);

		// When: its own `fx` configuration changes and it attaches again, as a reload does.
		setConfig(root, {
			fx: {
				...stdioServer(["--tools", "3", "--spawn-counter-file", spawnCounter]),
				exposure: "search",
				lifecycle: "eager",
			},
		});
		await attachFake(alphaPi);
		const result = await Reflect.apply(stale.execute, stale, ["stale", { value: "stale" }, undefined, undefined]);

		// Then: the offer made under the old configuration is refused instead of reaching the replaced server.
		expect(result).toMatchObject({ details: { error: { kind: "unavailable", server: "fx", tool: "tool_1" } } });
	});

	it("refuses an attach to a disposed service instead of opening connections nobody can close", async () => {
		// Given: the shared service was disposed.
		configureServer();
		const service = getMcpService();
		await service.dispose("quit");

		// When / Then: a late attach fails loudly and spawns no server.
		await expect(attachFakeTo(service, capturingPi())).rejects.toThrow(/disposed/);
		expect(service.getSnapshot().connectionCount).toBe(0);
		await expect(readCounter(spawnCounter)).rejects.toThrow();
	});

	it("re-registers a session that attached while a tool-list refresh was in flight", async () => {
		// Given: one session on an http server whose tool list then changes, with the refresh's listing held.
		const fixture = await httpServer();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
		const drained = nextRegistration();
		getMcpService().getConnection("fx")?.markToolsChanged();
		await drained;
		const listing = fixture.holdLists();
		await fixture.changeTools("late");
		await listing;

		// When: a second session attaches mid-refresh, then the listing completes.
		const bravoPi = capturingPi();
		await attachFake(bravoPi);
		const refreshed = untilFakeRegistered(bravoPi, "mcp_fx_late");
		fixture.releaseLists();
		await refreshed;

		// Then: both sessions carry the refreshed tool list.
		expect(alphaPi.registeredTools).toContain("mcp_fx_late");
		expect(bravoPi.registeredTools).toContain("mcp_fx_late");
	});

	it("lands a late catalog in the first session when a second session attaches while it is still listing", async () => {
		// Given: an http server whose first tool listing is held, so the first session's connect outlives its startup window.
		vi.stubEnv(MCP_STARTUP_TIMEOUT_ENV, "0");
		const fixture = await httpServer();
		const listing = fixture.holdLists();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await listing;

		// When: a second session attaches while that listing is in flight, then the listing completes.
		const bravoPi = capturingPi();
		await attachFake(bravoPi);
		const alphaRegistered = untilFakeRegistered(alphaPi, "mcp_fx_echo");
		fixture.releaseLists();

		// Then: the first session still gets the server's tools, not only the session that attached last.
		await alphaRegistered;
		expect(alphaPi.registeredTools).toContain("mcp_fx_echo");
	});

	it("disposes the service, starting no server, when the only session quits while its attach is still queued", async () => {
		// Given: the only session, whose attach is still queued.
		configureServer();
		const service = getMcpService();
		const alphaPi = capturingPi();
		const attach = attachFake(alphaPi);

		// When: it quits before the attach runs (a short-lived child that finishes immediately).
		await service.releaseSession(alphaPi, "quit");
		await attach;
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: the service is disposed, and the attach of the closed session started no session and no server process.
		expect(service.getSnapshot()).toMatchObject({ disposed: true, connectionCount: 0, sessionStartCount: 0 });
		await expect(readCounter(spawnCounter)).rejects.toThrow();
	});

	it("still delivers a refreshed tool list to the other sessions when one session's registration throws", async () => {
		// Given: two sessions on an http server, the first of which can no longer register tools.
		const fixture = await httpServer();
		const { alphaPi, bravoPi } = await twoHttpSessions();
		alphaPi.registerTool = () => {
			throw new Error("alpha's tool registry is broken");
		};

		// When: the server's tool list changes.
		const refreshed = untilFakeRegistered(bravoPi, "mcp_fx_late");
		await fixture.changeTools("late");

		// Then: the second session still receives the new tool.
		await refreshed;
		expect(bravoPi.registeredTools).toContain("mcp_fx_late");
		expect(alphaPi.registeredTools).not.toContain("mcp_fx_late");
	});
});

const SECRET_EXPR = "$" + "{SENPI_2986_SECRET}";

/** A skill whose sidecar declares `server` with a `${VAR}` in its stdio env. */
function skillDeclaring(name: string, scope: "user" | "project", server: string): SkillLike {
	const baseDir = join(root.cwd, "skills", name);
	mkdirSync(baseDir, { recursive: true });
	const filePath = join(baseDir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: test skill\n---\n\nBody.\n`);
	const raw = { ...stdioServer(["--tools", "1"]), env: { SENPI_2986_SECRET: SECRET_EXPR } };
	writeFileSync(join(baseDir, "mcp.json"), JSON.stringify({ [server]: raw }));
	return { baseDir, filePath, name, sourceInfo: { scope } };
}

async function attachAs(pi: CapturingPi, session: TestRoot, trusted: boolean, secret: string): Promise<void> {
	await getMcpService().attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: session.cwd, isProjectTrusted: () => trusted },
		pi,
		{ agentDir: session.agentDir, env: { SENPI_2986_SECRET: secret } },
	);
}

describe("senpi#2986: a session's skill servers follow its own trust, env and agent dir", () => {
	it("keeps an untrusted session's project skill server literal after a trusted peer attaches", async () => {
		// Given: an untrusted session, then a trusted peer with its own environment and agent dir attaching after it.
		setConfig(root, {});
		const peerRoot = makeRoot("2986-trusted-peer", cleanupTasks);
		setConfig(peerRoot, {});
		const alphaPi = capturingPi();
		await attachAs(alphaPi, root, false, "alpha-secret");
		await attachAs(capturingPi(), peerRoot, true, "peer-secret");

		// When: the untrusted session's skills declare a project-scoped and a user-scoped server.
		const skills = [skillDeclaring("cloned", "project", "fxp"), skillDeclaring("own", "user", "fxu")];
		const warnings = await getMcpService().attachSkillMcpServers(parseSkillMcpDeclarations(skills).servers, alphaPi);

		// Then: the project skill stays literal under the declaring session's trust, the user skill expands from that
		// session's env, and the servers' credentials resolve in its agent dir, never the trusted peer's.
		const service = getMcpService();
		expect(warnings).toEqual([expect.stringContaining("trust the project")]);
		expect(service.getAuthTarget("fxp")?.config.env).toEqual({ SENPI_2986_SECRET: SECRET_EXPR });
		expect(service.getAuthTarget("fxu")?.config.env).toEqual({ SENPI_2986_SECRET: "alpha-secret" });
		expect(service.getAuthTarget("fxu")).toMatchObject({
			agentDir: root.agentDir,
			env: { SENPI_2986_SECRET: "alpha-secret" },
		});
	});

	it("never offers a session a shared connection that carries a peer's credentials", async () => {
		// Given: an http server whose bearer token comes from each session's own env, and a session holding the
		// connection made with its token.
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, {
			fx: { type: "http", url: fixture.url, auth: "bearer", bearerTokenEnv: "SENPI_2986_TOKEN", lifecycle: "eager" },
		});
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		const attachWithToken = (pi: CapturingPi, token: string) =>
			getMcpService().attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi,
				{ agentDir: root.agentDir, env: { SENPI_2986_TOKEN: token } },
			);
		await attachWithToken(alphaPi, "alpha-token");
		await untilFakeRegistered(alphaPi, "mcp_fx_echo");

		// When: a peer declaring the same server with the same config but its own token attaches, and both call it.
		await attachWithToken(bravoPi, "bravo-token");
		await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
		await untilFakeRegistered(bravoPi, "mcp_fx_echo");
		const alphaTool = registeredTool(alphaPi, "mcp_fx_echo");
		const bravoTool = registeredTool(bravoPi, "mcp_fx_echo");
		const alphaResult = await Reflect.apply(alphaTool.execute, alphaTool, [
			"a",
			{ value: "a" },
			undefined,
			undefined,
		]);
		const bravoResult = await Reflect.apply(bravoTool.execute, bravoTool, [
			"b",
			{ value: "b" },
			undefined,
			undefined,
		]);

		// Then: the first session is refused instead of riding on the peer's token; the peer's own call goes through.
		expect(alphaResult).toMatchObject({ details: { error: { kind: "unavailable", server: "fx", tool: "echo" } } });
		expect(bravoResult).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ value: "b" }) }] });
		expect(fixture.callAuthorizations).toEqual(["Bearer bravo-token"]);
	});
});

describe("senpi#3001: a session's MCP status counts a shared connection only with its own credentials", () => {
	it("lists a peer's declared server with none of the live connection's catalog, server info or status", async () => {
		// Given: two sessions declare the same bearer http server with different tokens. The peer attaches first, then the
		// alpha session attaches last, so the live connection carries alpha's credentials.
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, {
			fx: { type: "http", url: fixture.url, auth: "bearer", bearerTokenEnv: "SENPI_3001_TOKEN", lifecycle: "eager" },
		});
		const service = getMcpService();
		const attachWithToken = (pi: CapturingPi, sessionId: string, token: string) =>
			service.attachSession(
				{ type: "session_start", reason: "startup" },
				{
					cwd: root.cwd,
					isProjectTrusted: () => true,
					mode: "app-server",
					sessionManager: { getEntries: () => [], getSessionId: () => sessionId },
				},
				pi,
				{ agentDir: root.agentDir, env: { SENPI_3001_TOKEN: token } },
			);
		await attachWithToken(capturingPi(), "bravo", "bravo-token");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);
		const alphaPi = capturingPi();
		await attachWithToken(alphaPi, "alpha", "alpha-token");
		await untilFakeRegistered(alphaPi, "mcp_fx_echo");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// When: each session reads its own MCP status.
		const alpha = await service.refreshWireStatusSnapshot("alpha");
		const bravo = await service.refreshWireStatusSnapshot("bravo");

		// Then: alpha sees its live connection, and bravo lists its own declaration with none of alpha's catalog, server
		// info or connected status.
		const alphaFx = alpha.servers.find((server) => server.name === "fx");
		const bravoFx = bravo.servers.find((server) => server.name === "fx");
		expect(alphaFx).toMatchObject({
			status: "connected",
			serverInfo: { name: "sharing-fixture" },
			authStatus: "bearerToken",
		});
		expect(alphaFx?.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(bravoFx).toMatchObject({
			serverInfo: null,
			tools: [],
			resources: [],
			resourceTemplates: [],
			authStatus: "bearerToken",
		});
		expect(bravoFx?.status).not.toBe("connected");
	});
});

describe("senpi#3001: a dispose that lands while a sync is stopping a connection", () => {
	it("creates no connection once a dispose lands during the sync's teardown", async () => {
		// Given: one session on a bearer http server, connected with its token.
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, {
			fx: { type: "http", url: fixture.url, auth: "bearer", bearerTokenEnv: "SENPI_3001_TOKEN", lifecycle: "eager" },
		});
		const service = getMcpService();
		const env: Record<string, string> = { SENPI_3001_TOKEN: "one" };
		const alphaPi = capturingPi();
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			alphaPi,
			{ agentDir: root.agentDir, env },
		);
		await untilFakeRegistered(alphaPi, "mcp_fx_echo");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);
		const stale = service.getConnection("fx");
		if (stale === undefined) throw new Error("fx never connected");

		// When: the token rotates, so the sync stops the stale connection. Its stop is the signal: the dispose lands from
		// inside that stop, before the sync's await on the teardown resolves.
		let disposing: Promise<void> | undefined;
		let connectsAtDispose = -1;
		const unsubscribe = stale.onStateChange((event) => {
			if (event.state !== "disabled") return;
			unsubscribe();
			connectsAtDispose = fixture.connects;
			disposing = service.dispose("quit");
		});
		env.SENPI_3001_TOKEN = "two";
		await service.reconnectServer("fx");
		expect(disposing).toBeDefined();
		await disposing;
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: the closed service holds no connection, and the sync created no server after the dispose.
		expect(service.getSnapshot()).toMatchObject({ disposed: true, connectionCount: 0 });
		expect(fixture.connects).toBe(connectsAtDispose);
	});
});

/** The shared `fx` for every session, plus `extra` declared only by the project at `root.cwd`; returns a peer project. */
function configureExtraForRootProject(): TestRoot {
	configureServer();
	writeProjectConfig(root.cwd, {
		extra: { ...stdioServer(["--tools", "1"]), exposure: "search", lifecycle: "eager" },
	});
	return makeRoot("2597-peer", cleanupTasks);
}

/** Attach an app-server session in `project` whose session id is `sessionId`, sharing the agent dir. */
async function attachInProject(
	pi: CapturingPi,
	project: TestRoot,
	sessionId: string,
	reason: "startup" | "reload" = "startup",
): Promise<void> {
	await getMcpService().attachSession(
		{ type: "session_start", reason },
		{
			cwd: project.cwd,
			isProjectTrusted: () => true,
			mode: "app-server",
			sessionManager: { getEntries: () => [], getSessionId: () => sessionId },
		},
		pi,
		{ agentDir: root.agentDir },
	);
}

describe("senpi#2597: a session's MCP status and the service's teardown follow the live sessions", () => {
	it("starts nothing for a session that quits while its first attach is queued, leaving the peer's servers untouched", async () => {
		// Given: a bound session on the global `fx`, and a peer project declaring its own `fx` and an `extra`.
		configureServer();
		const peer = makeRoot("2597-quit-queued", cleanupTasks);
		writeProjectConfig(peer.cwd, {
			fx: { ...stdioServer(["--tools", "3"]), exposure: "search", lifecycle: "eager" },
			extra: { ...stdioServer(["--tools", "1"]), exposure: "search", lifecycle: "eager" },
		});
		const service = getMcpService();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await untilFakeRegistered(alphaPi, TOOL);
		const fxPid = requiredPid(service, "fx");

		// When: the peer's first attach is queued, and the peer quits before it runs.
		const bravoPi = capturingPi();
		const bravoAttach = attachInProject(bravoPi, peer, "bravo");
		await service.releaseSession(bravoPi, "quit");
		await bravoAttach;
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: the bound session keeps its own `fx` process and tools, and the closed peer started no server.
		expect(requiredPid(service, "fx")).toBe(fxPid);
		await assertAlive(fxPid);
		expect(service.getConnection("extra")).toBeUndefined();
		const tool = registeredTool(alphaPi, TOOL);
		const result = await Reflect.apply(tool.execute, tool, ["q", { value: "after-quit" }, undefined, undefined]);
		expect(result).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("fixture tool_1 value=after-quit") }],
		});
		expect(service.getSnapshot()).toMatchObject({ disposed: false, connectionCount: 1 });
	});

	it("re-keys a session's connection when its credentials change after a skill attach replaced the merged config", async () => {
		// Given: a session whose http `fx` sends a bearer token from its own env, then loads a skill declaring a server.
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, {
			fx: { type: "http", url: fixture.url, auth: "bearer", bearerTokenEnv: "SENPI_2597_TOKEN", lifecycle: "eager" },
		});
		const env: Record<string, string> = { SENPI_2597_TOKEN: "one" };
		const service = getMcpService();
		const alphaPi = capturingPi();
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			alphaPi,
			{ agentDir: root.agentDir, env },
		);
		await untilFakeRegistered(alphaPi, "mcp_fx_echo");
		const skills = [skillDeclaring("own", "user", "fxs")];
		await service.attachSkillMcpServers(parseSkillMcpDeclarations(skills).servers, alphaPi);

		// When: its token changes, and the connection reconnects and notices.
		env.SENPI_2597_TOKEN = "two";
		await service.reconnectServer("fx");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: the connection is re-keyed to the new token, and the session's call goes through with it.
		expect(service.getConnection("fx")).toBeDefined();
		const tool = registeredTool(alphaPi, "mcp_fx_echo");
		const result = await Reflect.apply(tool.execute, tool, ["c", { value: "c" }, undefined, undefined]);
		expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ value: "c" }) }] });
		expect(fixture.callAuthorizations).toEqual(["Bearer two"]);
	});

	it("re-creates a shared connection whose credentials went stale with the current declarer's, instead of refusing every session", async () => {
		// Given: an http `fx` whose bearer token comes from each session's own env. Both sessions resolve the same token,
		// so the second keeps the connection the first created with its own env. It is lazy, so once its catalog is cached
		// a re-created connection does not connect on its own and only the re-sync republishes its tools.
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, {
			fx: { type: "http", url: fixture.url, auth: "bearer", bearerTokenEnv: "SENPI_2597_TOKEN", lifecycle: "lazy" },
		});
		const service = getMcpService();
		const attachWithEnv = (pi: CapturingPi, env: Record<string, string>) =>
			service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi,
				{ agentDir: root.agentDir, env },
			);
		const alphaEnv: Record<string, string> = { SENPI_2597_TOKEN: "shared" };
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		await attachWithEnv(alphaPi, alphaEnv);
		await untilFakeRegistered(alphaPi, "mcp_fx_echo");
		await attachWithEnv(bravoPi, { SENPI_2597_TOKEN: "shared" });
		await untilFakeRegistered(bravoPi, "mcp_fx_echo");

		// When: the first session's token rotates, and the connection reconnects and notices.
		alphaEnv.SENPI_2597_TOKEN = "rotated";
		await service.reconnectServer("fx");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: the connection is re-created with the most recent declarer's credentials, and its call goes through.
		expect(service.getConnection("fx")).toBeDefined();
		const tool = registeredTool(bravoPi, "mcp_fx_echo");
		const result = await Reflect.apply(tool.execute, tool, ["b", { value: "b" }, undefined, undefined]);
		expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ value: "b" }) }] });
		expect(fixture.callAuthorizations).toEqual(["Bearer shared"]);
	});

	// The FIFO holds the skill attach's catalog-cache read until the release has run, with no hook in the service.
	it.skipIf(process.platform === "win32")(
		"never re-creates a released session's skill server after a release re-sync that ran during its skill attach",
		async () => {
			// Given: a session in its own agent dir, whose catalog-cache file is a FIFO that blocks a read until the test
			// writes it, and a live peer; neither declares a server of its own.
			const owner = makeRoot("2597-skill-owner", cleanupTasks);
			setConfig(owner, {});
			setConfig(root, {});
			const service = getMcpService();
			const alphaPi = capturingPi();
			await attachAs(alphaPi, owner, true, "alpha-secret");
			await attachFake(capturingPi());
			const cachePath = getMcpCatalogCachePath(owner.agentDir);
			mkdirSync(dirname(cachePath), { recursive: true });
			execFileSync("mkfifo", [cachePath]);
			// Held open for writing, so a reader's open never blocks and its read waits for the test's data.
			const writer = openSync(cachePath, constants.O_RDWR);

			// When: the session loads a skill declaring a server, and quits while that skill attach is in flight.
			const skills = parseSkillMcpDeclarations([skillDeclaring("own", "user", "fxs")]).servers;
			const skillAttach = service.attachSkillMcpServers(skills, alphaPi);
			await service.releaseSession(alphaPi, "quit");
			writeSync(writer, "{}");
			closeSync(writer);
			await skillAttach;

			// Then: the server only the released session declared has no connection, and the peer keeps the service.
			expect(service.getConnection("fxs")).toBeUndefined();
			expect(service.getSnapshot()).toMatchObject({ disposed: false, connectionCount: 0 });
		},
	);

	it("lists only a session's own servers in its MCP status, never a peer's", async () => {
		// Given: the first session's project declares `extra` beside the shared `fx`; a peer elsewhere declares only `fx`.
		const peer = configureExtraForRootProject();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		await attachInProject(alphaPi, root, "alpha");
		await untilFakeRegistered(alphaPi, EXTRA_TOOL);
		await attachInProject(bravoPi, peer, "bravo");
		await untilFakeRegistered(bravoPi, TOOL);

		// When: each session asks for its MCP status.
		const alpha = await getMcpService().refreshWireStatusSnapshot("alpha");
		const bravo = await getMcpService().refreshWireStatusSnapshot("bravo");

		// Then: each lists the servers its own config declares, though the shared service runs both.
		expect(alpha.servers.map((server) => server.name)).toEqual(["extra", "fx"]);
		expect(bravo.servers.map((server) => server.name)).toEqual(["fx"]);
		expect(getMcpService().getConnection("extra")).toBeDefined();
	});

	it("drops a quit session's MCP status snapshot and keeps the live session's", async () => {
		// Given: two sessions with their own session ids, each with a captured MCP status.
		configureServer();
		const service = getMcpService();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		await attachInProject(alphaPi, root, "alpha");
		await attachInProject(bravoPi, root, "bravo");
		await untilFakeRegistered(bravoPi, TOOL);
		await service.refreshWireStatusSnapshot("alpha");
		await service.refreshWireStatusSnapshot("bravo");

		// When: the first session quits.
		await service.releaseSession(alphaPi, "quit");

		// Then: its snapshot is gone, while the live session's stays.
		expect(service.getWireStatusSnapshot("alpha")).toEqual({ servers: [] });
		expect(service.getWireStatusSnapshot("bravo").servers.map((server) => server.name)).toEqual(["fx"]);
	});

	// The FIFO holds the attach's catalog-cache read, after it bound, until the test writes it.
	it.skipIf(process.platform === "win32")(
		"stores no MCP status for a session that quits while its own attach is running",
		async () => {
			// Given: a live peer, and a session in its own agent dir whose project declares `extra` and whose catalog-cache
			// file is a FIFO.
			configureServer();
			const service = getMcpService();
			await attachInProject(capturingPi(), root, "bravo");
			const owner = makeRoot("2597-capture-owner", cleanupTasks);
			setConfig(owner, {});
			writeProjectConfig(owner.cwd, {
				extra: { ...stdioServer(["--tools", "1"]), exposure: "search", lifecycle: "eager" },
			});
			const cachePath = getMcpCatalogCachePath(owner.agentDir);
			mkdirSync(dirname(cachePath), { recursive: true });
			execFileSync("mkfifo", [cachePath]);

			// When: the session's attach binds and waits on the FIFO; the session quits, then the attach resumes.
			const alphaPi = capturingPi();
			const bound = Promise.withResolvers<void>();
			const attach = service.attachSession(
				{ type: "session_start", reason: "startup" },
				{
					cwd: owner.cwd,
					isProjectTrusted: () => true,
					mode: "app-server",
					sessionManager: { getEntries: () => [], getSessionId: () => "alpha" },
					// Read just before the attach binds; the rest of its turn runs to the cache read before this resolves.
					getRegisteredMcpServers: () => {
						bound.resolve();
						return [];
					},
				},
				alphaPi,
				{ agentDir: owner.agentDir },
			);
			await bound.promise;
			await service.releaseSession(alphaPi, "quit");
			// Opening for writing blocks until the attach's read has opened the FIFO, so it receives the data and the end.
			const writer = openSync(cachePath, constants.O_WRONLY);
			writeSync(writer, "{}");
			closeSync(writer);
			await attach;
			await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

			// Then: the closed session's status snapshot was never stored.
			expect(service.getWireStatusSnapshot("alpha")).toEqual({ servers: [] });
		},
	);

	it("keeps a reloading session's own servers running while a peer is live", async () => {
		// Given: the first session alone declares `extra`, both declare `fx`, and both servers are connected.
		const peer = configureExtraForRootProject();
		const service = getMcpService();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		await attachInProject(alphaPi, root, "alpha");
		await untilFakeRegistered(alphaPi, EXTRA_TOOL);
		await attachInProject(bravoPi, peer, "bravo");
		await untilFakeRegistered(bravoPi, TOOL);
		const extraPid = requiredPid(service, "extra");

		// When: the first session reloads: its old extension instance is released with no dispose reason, and the
		// reloaded one attaches.
		await service.releaseSession(alphaPi);
		await attachInProject(capturingPi(), root, "alpha", "reload");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: its own `extra` kept running on the same process, never stopped and re-spawned.
		expect(requiredPid(service, "extra")).toBe(extraPid);
		await assertAlive(extraPid);
	});

	it("keeps a reloading session's own servers running when a peer's credentials change before it attaches again", async () => {
		// Given: the first session's project alone declares `extra`; a peer in its own agent dir alone declares an http
		// `fx` whose bearer token comes from its env.
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, {});
		writeProjectConfig(root.cwd, {
			extra: { ...stdioServer(["--tools", "1"]), exposure: "search", lifecycle: "eager" },
		});
		const peer = makeRoot("2597-credential-peer", cleanupTasks);
		setConfig(peer, {
			fx: { type: "http", url: fixture.url, auth: "bearer", bearerTokenEnv: "SENPI_2597_TOKEN", lifecycle: "eager" },
		});
		const service = getMcpService();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		const bravoEnv: Record<string, string> = { SENPI_2597_TOKEN: "one" };
		await attachInProject(alphaPi, root, "alpha");
		await untilFakeRegistered(alphaPi, EXTRA_TOOL);
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: peer.cwd, isProjectTrusted: () => true },
			bravoPi,
			{ agentDir: peer.agentDir, env: bravoEnv },
		);
		await untilFakeRegistered(bravoPi, "mcp_fx_echo");
		const extraPid = requiredPid(service, "extra");

		// When: the first session reloads: its old instance is released with no dispose reason, and before the reloaded
		// one attaches, the peer's token changes and its connection reconnects and re-keys.
		await service.releaseSession(alphaPi);
		bravoEnv.SENPI_2597_TOKEN = "two";
		await service.reconnectServer("fx");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);
		expect(service.getConnection("fx")).toBeDefined();
		const extraAfterCredentials = requiredPid(service, "extra");
		await attachInProject(capturingPi(), root, "alpha", "reload");
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: `extra` kept the same process through the credential re-sync and the reloaded attach.
		expect(extraAfterCredentials).toBe(extraPid);
		expect(requiredPid(service, "extra")).toBe(extraPid);
		await assertAlive(extraPid);
	});

	it("stops a session's own servers when a reload removes the MCP builtin while a peer is live", async () => {
		// Given: the first session alone declares `extra`, both declare `fx`, and both servers are connected.
		const peer = configureExtraForRootProject();
		const service = getMcpService();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		await attachInProject(alphaPi, root, "alpha");
		await untilFakeRegistered(alphaPi, EXTRA_TOOL);
		await attachInProject(bravoPi, peer, "bravo");
		await untilFakeRegistered(bravoPi, TOOL);
		const extraPid = requiredPid(service, "extra");

		// When: the first session reloads into a runtime without the MCP builtin: its shutdown releases it with no dispose
		// reason, then the builtin's removal releases it again with one.
		await service.releaseSession(alphaPi);
		await service.releaseSession(alphaPi, "reload");

		// Then: the server no live session declares any more is stopped.
		expect(service.getConnection("extra")).toBeUndefined();
		await assertProcessDead(extraPid);
	});

	it("leaves no connection or server process when two sessions quit while a release re-sync is stopping a server", async () => {
		// Given: the first session alone declares `extra`, both declare `fx`, and both servers are connected.
		const peer = configureExtraForRootProject();
		const service = getMcpService();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		await attachInProject(alphaPi, root, "alpha");
		await untilFakeRegistered(alphaPi, EXTRA_TOOL);
		await attachInProject(bravoPi, peer, "bravo");
		await untilFakeRegistered(bravoPi, TOOL);
		const fxPid = requiredPid(service, "fx");
		const extraPid = requiredPid(service, "extra");
		const extra = service.getConnection("extra");
		const extraStopping = new Promise<void>((resolve) => {
			const unsubscribe = extra?.onStateChange((event) => {
				if (event.state !== "disabled") return;
				unsubscribe?.();
				resolve();
			});
		});

		// When: the first session quits, and the second quits while that release's re-sync is still stopping `extra`.
		const alphaRelease = service.releaseSession(alphaPi, "quit");
		await extraStopping;
		const bravoRelease = service.releaseSession(bravoPi, "quit");
		await Promise.all([alphaRelease, bravoRelease]);

		// Then: the service is disposed with no connection, both server processes are gone, and `fx` never re-spawned.
		expect(service.getSnapshot()).toMatchObject({ disposed: true, connectionCount: 0 });
		await assertProcessDead(fxPid);
		await assertProcessDead(extraPid);
		expect(await readCounter(spawnCounter)).toBe(1);
	});
});

async function attachFakeTo(service: ReturnType<typeof getMcpService>, pi: CapturingPi): Promise<void> {
	await service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true },
		pi,
		{ agentDir: root.agentDir },
	);
}

const ALPHA_ONLY_INSTRUCTIONS = "Use the extra server only from the first session.";

/** Declare `extra` with server instructions from a session's own extensions, so only that session's config has it. */
function registerInstructedExtraServer(pi: ExtensionAPI): void {
	const fixture = stdioFixtureCommand();
	pi.registerMcpServer("extra", {
		type: "stdio",
		command: fixture.command,
		args: [...fixture.args, "--tools", "1", "--instructions", ALPHA_ONLY_INSTRUCTIONS],
		exposure: "search",
		lifecycle: "eager",
	});
}

/** Two app-server sessions: the first's project declares `extra` beside the shared `fx`, the peer's only `fx`. */
async function twoProjectSessions(): Promise<{ alphaPi: CapturingPi; bravoPi: CapturingPi }> {
	const peer = configureExtraForRootProject();
	const alphaPi = capturingPi();
	const bravoPi = capturingPi();
	await attachInProject(alphaPi, root, "alpha");
	await untilFakeRegistered(alphaPi, EXTRA_TOOL);
	await attachInProject(bravoPi, peer, "bravo");
	await untilFakeRegistered(bravoPi, TOOL);
	return { alphaPi, bravoPi };
}

/** Two live sessions: the first alone declares `extra`, whose server sends instructions; both declare `fx`. */
async function twoInstructedSessions(): Promise<{ alpha: Harness; bravo: Harness }> {
	configureServer();
	const alpha = await openSession(await mcpExtensions(registerInstructedExtraServer));
	await untilToolRegistered(alpha, EXTRA_TOOL);
	const bravo = await openSession();
	await untilToolRegistered(bravo, TOOL);
	await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
	return { alpha, bravo };
}

async function systemPromptOf(harness: Harness): Promise<string> {
	let systemPrompt = "";
	harness.setResponses([
		(context) => {
			systemPrompt = getCurrentSystemPrompt(context.messages);
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("capture prompt");
	return systemPrompt;
}

describe("senpi#3001: a session sees only its own MCP servers in its status, snapshots, /mcp and instructions", () => {
	it("gives a caller naming no session no peer's MCP status while two sessions are live", async () => {
		// Given: two live sessions with their own MCP status; only the first declares `extra`.
		const { bravoPi } = await twoProjectSessions();
		const service = getMcpService();

		// When: a caller that names no session refreshes and reads the status.
		const refreshed = await service.refreshWireStatusSnapshot();
		const read = service.getWireStatusSnapshot();

		// Then: it gets no session's status, not the one that attached or captured last; once the peer quits, the sole
		// live session's own status.
		expect(refreshed).toEqual({ servers: [] });
		expect(read).toEqual({ servers: [] });
		await service.releaseSession(bravoPi, "quit");
		expect((await service.refreshWireStatusSnapshot()).servers.map((server) => server.name)).toEqual(["extra", "fx"]);
	});

	it("lists only a session's own servers in its server snapshots and exposure, never a peer's", async () => {
		// Given: two live sessions; only the first declares `extra`, which is connected.
		const { alphaPi, bravoPi } = await twoProjectSessions();
		const service = getMcpService();

		// When: each session reads its server snapshots and the exposure of `extra`, and a caller naming none reads them.
		const bravo = service.getServerSnapshots(bravoPi);
		const alpha = service.getServerSnapshots(alphaPi);

		// Then: the peer sees neither the server nor the connection only the first session declares.
		expect(bravo.map((snapshot) => snapshot.name)).toEqual(["fx"]);
		expect(await service.getServerExposureStatus("extra", bravoPi)).toEqual({ toolCount: null });
		expect(alpha.map((snapshot) => snapshot.name)).toEqual(["extra", "fx"]);
		expect(service.getServerSnapshots()).toEqual([]);
	});

	it(
		"keeps a server's instructions out of a peer session's system prompt",
		async () => {
			// Given: two live sessions; only the first declares `extra`, whose server sends instructions.
			const { alpha, bravo } = await twoInstructedSessions();

			// When: each session sends a turn.
			const alphaPrompt = await systemPromptOf(alpha);
			const bravoPrompt = await systemPromptOf(bravo);

			// Then: only the session that declares `extra` is instructed by it.
			expect(alphaPrompt).toContain(ALPHA_ONLY_INSTRUCTIONS);
			expect(bravoPrompt).not.toContain(ALPHA_ONLY_INSTRUCTIONS);
		},
		REGISTRATION_TIMEOUT_MS * 3,
	);

	it(
		"shows only a session's own servers in its /mcp status",
		async () => {
			// Given: two live sessions; only the first declares `extra`.
			const { bravo } = await twoInstructedSessions();
			const ui = createUi();
			const runner = bravo.getExtensionRunner();
			runner.setUIContext(ui);

			// When: the peer runs `/mcp status`.
			await runner.getCommand("mcp")?.handler("status", runner.createCommandContext());

			// Then: its status lists its own `fx` and not the first session's `extra`.
			const status = ui.notifications.at(-1)?.message ?? "";
			expect(status).toContain("fx");
			expect(status).not.toContain("extra");
		},
		REGISTRATION_TIMEOUT_MS * 3,
	);
});

describe("senpi#3001: /mcp auth commands reach only a server the session declares", () => {
	it(
		"refuses a peer's /mcp logout of a server only the first session declares",
		async () => {
			// Given: two live sessions; only the first declares `extra`, which is connected.
			const { bravo } = await twoInstructedSessions();
			const extra = getMcpService().getConnection("extra");
			if (extra === undefined) throw new Error("extra never connected");
			const generation = extra.generation;
			const ui = createUi();
			const runner = bravo.getExtensionRunner();
			runner.setUIContext(ui);

			// When: the peer runs `/mcp logout extra`.
			await runner.getCommand("mcp")?.handler("logout extra", runner.createCommandContext());

			// Then: it is refused as unknown, logs nothing out, and leaves the first session's connection untouched.
			expect(ui.notifications).toContainEqual({ message: "Unknown MCP server: extra", type: "error" });
			expect(JSON.stringify(ui.notifications)).not.toContain("logged out");
			expect(JSON.stringify(bravo.sessionManager.getEntries())).not.toContain("logged out");
			expect(getMcpService().getConnection("extra")).toBe(extra);
			expect(extra.generation).toBe(generation);
		},
		REGISTRATION_TIMEOUT_MS * 3,
	);
});

describe("senpi#3001: a session handle the service has not bound sees no peer's MCP servers", () => {
	it("gives a released session's handle no server, connection or exposure while a peer is live", async () => {
		// Given: two live sessions; only the first declares `extra`, which is connected.
		const { bravoPi } = await twoProjectSessions();
		const service = getMcpService();

		// When: the peer is released with no dispose reason, as a reload, new, resume or fork does before its next attach.
		await service.releaseSession(bravoPi);

		// Then: its handle sees nothing, not the servers and connections of the sole live session, its peer.
		expect(service.getServerSnapshots(bravoPi)).toEqual([]);
		expect(service.getConnection("extra", bravoPi)).toBeUndefined();
		expect(await service.getServerExposureStatus("extra", bravoPi)).toEqual({ toolCount: null });
		expect(service.getConnection("extra")).toBeDefined();
	});
});

const INST_TOOL = "mcp_inst_tool_1";
const ALPHA_INST = "Follow the first session configuration of the inst server.";
const BRAVO_INST = "Follow the peer configuration of the inst server.";

/** A live session whose own extensions declare `inst` with these server instructions, each text its own config hash. */
async function openInstSession(instructions: string): Promise<Harness> {
	const harness = await openSession(
		await mcpExtensions((pi) => {
			const fixture = stdioFixtureCommand();
			pi.registerMcpServer("inst", {
				type: "stdio",
				command: fixture.command,
				args: [...fixture.args, "--tools", "1", "--instructions", instructions],
				exposure: "search",
				lifecycle: "eager",
			});
		}),
	);
	await untilToolRegistered(harness, INST_TOOL);
	await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
	return harness;
}

describe("senpi#3001: a raced connect rebuilds the instructions of every live session", () => {
	it(
		"drops a server's instructions from a session whose connection a peer's config replaced",
		async () => {
			// Given: the first session declares `inst` and is instructed by it.
			setConfig(root, {});
			const alpha = await openInstSession(ALPHA_INST);
			expect(await systemPromptOf(alpha)).toContain(ALPHA_INST);

			// When: a peer declaring `inst` with another config attaches last, so its connection replaces the first's.
			const bravo = await openInstSession(BRAVO_INST);

			// Then: the first session's next turn carries no instructions from a connection it no longer has, nor the
			// peer's; the peer's turn carries its own.
			const alphaPrompt = await systemPromptOf(alpha);
			expect(alphaPrompt).not.toContain(ALPHA_INST);
			expect(alphaPrompt).not.toContain(BRAVO_INST);
			expect(await systemPromptOf(bravo)).toContain(BRAVO_INST);
		},
		REGISTRATION_TIMEOUT_MS * 3,
	);
});
