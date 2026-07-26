import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, McpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { Extension, SessionShutdownEvent, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { awaitMcpToolRegistration } from "./fixtures/register-call.ts";
import {
	awaitMcpConnected,
	cleanupRoots,
	fakePi,
	makeRoot,
	readCounter,
	requiredPid,
	setConfig,
	stdioServer,
	type TestRoot,
} from "./fixtures/service-lifecycle.ts";
import { assertProcessDead, stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const scopedServices: McpService[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];

describe("mcp builtin extension load", () => {
	beforeEach(() => {
		resetMcpServiceForTests();
	});

	afterEach(async () => {
		await Promise.all(scopedServices.splice(0).map((service) => service.dispose("quit")));
		await getMcpService().dispose("quit");
		resetMcpServiceForTests();
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		await cleanupRoots(cleanupTasks);
	});

	it("registers the mcp builtin factory", () => {
		expect(builtinExtensions.some((extension) => extension.id === "mcp")).toBe(true);
	});

	it("keeps the factory no-op without session/config work", async () => {
		const extension = await loadMcpBuiltinExtension();

		expect(extension.tools.size).toBe(0);
		expect([...extension.commands.keys()]).toEqual(["mcp"]);
		expect(extension.flags.size).toBe(0);
		expect(extension.handlers.get("session_start")).toHaveLength(1);
		expect(extension.handlers.get("session_shutdown")).toHaveLength(1);
		expect(extension.handlers.get("session_extensions_removed")).toHaveLength(1);
	});

	it("retains the singleton across session switches and classic reloads, disposing only for quit", async () => {
		for (const reason of ["new", "resume", "fork", "reload"] as const) {
			const extension = await loadMcpBuiltinExtension();

			await emitSessionStart(extension, "startup");
			await emitSessionShutdown(extension, reason);

			expect(getMcpService().getSnapshot()).toMatchObject({
				disposed: false,
				disposeCount: 0,
				lastSessionStartReason: "startup",
				sessionStartCount: 1,
				hasSessionContext: true,
			});
			resetMcpServiceForTests();
		}

		const extension = await loadMcpBuiltinExtension();

		await emitSessionStart(extension, "startup");
		await emitSessionStart(extension, "resume");
		const serviceBeforeShutdown = getMcpService();
		await emitSessionShutdown(extension, "quit");
		await emitSessionShutdown(extension, "quit");

		expect(serviceBeforeShutdown.getSnapshot()).toMatchObject({
			disposed: true,
			disposeCount: 1,
			lastDisposeReason: "quit",
			lastSessionStartReason: "resume",
			sessionStartCount: 2,
			hasSessionContext: false,
		});
	});

	it("keeps the same classic singleton alive across reload shutdown and start", async () => {
		const extension = await loadMcpBuiltinExtension();

		await emitSessionStart(extension, "startup");
		const serviceBeforeReload = getMcpService();
		await emitSessionShutdown(extension, "reload");

		expect(getMcpService()).toBe(serviceBeforeReload);
		expect(serviceBeforeReload.getSnapshot()).toMatchObject({
			disposed: false,
			disposeCount: 0,
			lastSessionStartReason: "startup",
			sessionStartCount: 1,
			hasSessionContext: true,
		});

		await emitSessionStart(extension, "reload");

		expect(getMcpService()).toBe(serviceBeforeReload);
		expect(serviceBeforeReload.getSnapshot()).toMatchObject({
			disposed: false,
			disposeCount: 0,
			lastDisposeReason: null,
			lastSessionStartReason: "reload",
			sessionStartCount: 2,
			hasSessionContext: true,
		});
	});

	it("preserves a classic stdio child across reload", async () => {
		const root = makeMcpRoot("classic-reload");
		const counterFile = `${root.agentDir}/classic-reload-spawns.txt`;
		setConfig(root, { fixture: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]) });
		const extension = await loadMcpBuiltinExtension();
		const ctx = mcpContext(root);

		await emitSessionStart(extension, "startup", ctx);
		const service = getMcpService();
		await awaitMcpConnected(service, "fixture");
		const pid = requiredPid(service, "fixture");
		await emitSessionShutdown(extension, "reload", ctx);

		expect(getMcpService()).toBe(service);
		expect(service.isDisposed()).toBe(false);
		await emitSessionStart(extension, "reload", ctx);
		await awaitMcpConnected(service, "fixture");

		expect(requiredPid(service, "fixture")).toBe(pid);
		expect(await readCounter(counterFile)).toBe(1);
		expect(service.getConnection("fixture")?.state).toBe("connected");
	});

	it("disposes the preserved classic singleton when the MCP builtin is removed during reload", async () => {
		const root = makeMcpRoot("removed-on-reload");
		const counterFile = `${root.agentDir}/removed-on-reload-spawns.txt`;
		setConfig(root, { fixture: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]) });
		const extension = await loadMcpBuiltinExtension();
		const ctx = mcpContext(root);

		await emitSessionStart(extension, "startup", ctx);
		const service = getMcpService();
		await awaitMcpConnected(service, "fixture");
		const pid = requiredPid(service, "fixture");
		await emitSessionShutdown(extension, "reload", ctx);

		expect(service.isDisposed()).toBe(false);
		await emit(extension, "session_extensions_removed", {
			type: "session_extensions_removed",
			reason: "reload",
			removed: [{ path: "<builtin:mcp>", resolvedPath: "<builtin:mcp>" }],
		});

		expect(service.isDisposed()).toBe(true);
		await assertProcessDead(pid);
	});

	it("keeps one child and connection inventory through three consecutive classic reloads", async () => {
		const root = makeMcpRoot("three-classic-reloads");
		const counterFile = `${root.agentDir}/three-classic-reload-spawns.txt`;
		setConfig(root, { fixture: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]) });
		const extension = await loadMcpBuiltinExtension();
		const ctx = mcpContext(root);

		await emitSessionStart(extension, "startup", ctx);
		const service = getMcpService();
		await awaitMcpConnected(service, "fixture");
		const pid = requiredPid(service, "fixture");

		for (let reload = 0; reload < 3; reload++) {
			await emitSessionShutdown(extension, "reload", ctx);
			await emitSessionStart(extension, "reload", ctx);
			await awaitMcpConnected(service, "fixture");
			expect(service.getSnapshot().connectionCount).toBe(1);
			expect(requiredPid(service, "fixture")).toBe(pid);
			expect(await readCounter(counterFile)).toBe(1);
		}
	});

	it("disposes provider-scoped services on reload and quit", async () => {
		for (const reason of ["reload", "quit"] as const) {
			const root = makeMcpRoot(`scoped-${reason}`);
			const counterFile = `${root.agentDir}/scoped-${reason}-spawns.txt`;
			setConfig(root, { fixture: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]) });
			const scope = new ProviderScope();
			const service = new McpService();
			scopedServices.push(service);
			const extension = await runWithProviderScope(scope, () =>
				loadExtensionFromFactory(
					createMcpExtension(service, true),
					root.cwd,
					createEventBus(),
					createExtensionRuntime(),
					"<builtin:mcp>",
				),
			);
			const ctx = mcpContext(root);

			await emitSessionStart(extension, "startup", ctx);
			await awaitMcpConnected(service, "fixture");
			const pid = requiredPid(service, "fixture");
			await emitSessionShutdown(extension, reason, ctx);

			expect(service.getSnapshot()).toMatchObject({
				disposed: true,
				disposeCount: 1,
				lastDisposeReason: reason,
			});
			await assertProcessDead(pid);
			scope.close();
		}
	});

	it("registers tools from an extension-declared MCP server with source=extension", async () => {
		const fixture = stdioFixtureCommand();
		const pi = fakePi();
		await getMcpService().attachSession(
			{ type: "session_start", reason: "startup" },
			{
				cwd: process.cwd(),
				isProjectTrusted: () => true,
				getRegisteredMcpServers: () => [
					{
						name: "fixture",
						config: { type: "stdio", ...fixture, args: [...fixture.args, "--tools", "2"] },
						extensionPath: "<ext>",
						registrationCwd: process.cwd(),
					},
				],
			},
			pi,
		);
		await awaitMcpToolRegistration("fixture");

		const snapshot = getMcpService()
			.getServerSnapshots()
			.find((s) => s.name === "fixture");
		const tools = getMcpService()
			.getTierBSearchable()
			.map((t) => t.name)
			.filter((n) => n.startsWith("mcp_fixture_"));
		expect(snapshot?.source).toBe("extension");
		expect(tools.length).toBeGreaterThan(0);
		expect(pi.activeTools).toContain("mcp_fixture_tool_1");
		await getMcpService().dispose("quit");
	});
});

function getMcpBuiltinEntry() {
	const entry = builtinExtensions.find((extension) => extension.id === "mcp");
	if (!entry) {
		throw new Error("mcp builtin extension entry was not registered");
	}
	return entry;
}

function loadMcpBuiltinExtension(): Promise<Extension> {
	return loadExtensionFromFactory(
		getMcpBuiltinEntry().factory,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<mcp-builtin-test>",
	);
}

function makeMcpRoot(slug: string): TestRoot {
	const root = makeRoot(`extension-load-${slug}`, cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	return root;
}

function mcpContext(root: TestRoot) {
	return { cwd: root.cwd, isProjectTrusted: () => true };
}

async function emitSessionStart(
	extension: Extension,
	reason: SessionStartEvent["reason"],
	ctx: unknown = {},
): Promise<void> {
	const event: SessionStartEvent = { type: "session_start", reason };
	await emit(extension, "session_start", event, ctx);
}

async function emitSessionShutdown(
	extension: Extension,
	reason: SessionShutdownEvent["reason"],
	ctx: unknown = {},
): Promise<void> {
	const event: SessionShutdownEvent = { type: "session_shutdown", reason };
	await emit(extension, "session_shutdown", event, ctx);
}

async function emit(extension: Extension, name: string, event: unknown, ctx: unknown = {}): Promise<void> {
	for (const handler of extension.handlers.get(name) ?? []) {
		await handler(event, ctx);
	}
}
