import { beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { Extension, SessionShutdownEvent, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { fakePi } from "./fixtures/service-lifecycle.ts";
import { stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

describe("mcp builtin extension load", () => {
	beforeEach(() => {
		resetMcpServiceForTests();
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
	});

	it("retains the singleton across session switches and disposes only for quit or reload", async () => {
		for (const reason of ["new", "resume", "fork"] as const) {
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

		for (const reason of ["quit", "reload"] as const) {
			const extension = await loadMcpBuiltinExtension();

			await emitSessionStart(extension, "startup");
			await emitSessionStart(extension, "resume");
			const serviceBeforeShutdown = getMcpService();
			await emitSessionShutdown(extension, reason);
			await emitSessionShutdown(extension, reason);

			expect(serviceBeforeShutdown.getSnapshot()).toMatchObject({
				disposed: true,
				disposeCount: 1,
				lastDisposeReason: reason,
				lastSessionStartReason: "resume",
				sessionStartCount: 2,
				hasSessionContext: false,
			});
			resetMcpServiceForTests();
		}
	});

	it("creates a usable singleton for a new session after reload disposal", async () => {
		const extension = await loadMcpBuiltinExtension();

		await emitSessionStart(extension, "startup");
		const serviceBeforeReload = getMcpService();
		await emitSessionShutdown(extension, "reload");

		expect(serviceBeforeReload.getSnapshot()).toMatchObject({
			disposed: true,
			disposeCount: 1,
			lastDisposeReason: "reload",
			hasSessionContext: false,
		});

		await emitSessionStart(extension, "reload");
		const serviceAfterReload = getMcpService();

		expect(serviceAfterReload).not.toBe(serviceBeforeReload);
		expect(serviceAfterReload.getSnapshot()).toMatchObject({
			disposed: false,
			disposeCount: 0,
			lastDisposeReason: null,
			lastSessionStartReason: "reload",
			sessionStartCount: 1,
			hasSessionContext: true,
		});
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

async function emitSessionStart(extension: Extension, reason: SessionStartEvent["reason"]): Promise<void> {
	const event: SessionStartEvent = { type: "session_start", reason };
	await emit(extension, "session_start", event);
}

async function emitSessionShutdown(extension: Extension, reason: SessionShutdownEvent["reason"]): Promise<void> {
	const event: SessionShutdownEvent = { type: "session_shutdown", reason };
	await emit(extension, "session_shutdown", event);
}

async function emit(extension: Extension, name: string, event: unknown): Promise<void> {
	for (const handler of extension.handlers.get(name) ?? []) {
		await handler(event, {});
	}
}
