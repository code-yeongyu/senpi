import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";

type EventHandler = ExtensionHandler<unknown>;
type EventHandlers = Map<string, EventHandler[]>;

interface RecordedExtensionApi {
	api: ExtensionAPI;
	events: EventHandlers;
	registerTool: ReturnType<typeof vi.fn<ExtensionAPI["registerTool"]>>;
	registerCommand: ReturnType<typeof vi.fn<ExtensionAPI["registerCommand"]>>;
	registerFlag: ReturnType<typeof vi.fn<ExtensionAPI["registerFlag"]>>;
}

describe("mcp builtin extension load", () => {
	beforeEach(() => {
		resetMcpServiceForTests();
	});

	it("registers the mcp builtin factory", () => {
		expect(builtinExtensions.some((extension) => extension.id === "mcp")).toBe(true);
	});

	it("keeps the factory no-op without session/config work", () => {
		const entry = getMcpBuiltinEntry();
		const recorded = createRecordedExtensionApi();

		entry.factory(recorded.api);

		expect(recorded.registerTool).not.toHaveBeenCalled();
		expect(recorded.registerCommand).not.toHaveBeenCalled();
		expect(recorded.registerFlag).not.toHaveBeenCalled();
		expect(recorded.events.get("session_start")).toHaveLength(1);
		expect(recorded.events.get("session_shutdown")).toHaveLength(1);
	});

	it("retains the singleton across session switches and disposes only for quit or reload", async () => {
		for (const reason of ["new", "resume", "fork"] as const) {
			const recorded = createRecordedExtensionApi();
			getMcpBuiltinEntry().factory(recorded.api);

			await emitSessionStart(recorded.events, "startup");
			await emitSessionShutdown(recorded.events, reason);

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
			const recorded = createRecordedExtensionApi();
			getMcpBuiltinEntry().factory(recorded.api);

			await emitSessionStart(recorded.events, "startup");
			await emitSessionStart(recorded.events, "resume");
			const serviceBeforeShutdown = getMcpService();
			await emitSessionShutdown(recorded.events, reason);
			await emitSessionShutdown(recorded.events, reason);

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
		const recorded = createRecordedExtensionApi();
		getMcpBuiltinEntry().factory(recorded.api);

		await emitSessionStart(recorded.events, "startup");
		const serviceBeforeReload = getMcpService();
		await emitSessionShutdown(recorded.events, "reload");

		expect(serviceBeforeReload.getSnapshot()).toMatchObject({
			disposed: true,
			disposeCount: 1,
			lastDisposeReason: "reload",
			hasSessionContext: false,
		});

		await emitSessionStart(recorded.events, "reload");
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
});

function getMcpBuiltinEntry() {
	const entry = builtinExtensions.find((extension) => extension.id === "mcp");
	expect(entry).toBeDefined();
	return entry!;
}

function createRecordedExtensionApi(): RecordedExtensionApi {
	const events: EventHandlers = new Map();
	const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
	const registerFlag = vi.fn<ExtensionAPI["registerFlag"]>();
	const api = {
		on(event: string, handler: EventHandler): void {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
		},
		registerTool,
		registerCommand,
		registerFlag,
	} as unknown as ExtensionAPI;
	return { api, events, registerTool, registerCommand, registerFlag };
}

async function emitSessionStart(events: EventHandlers, reason: SessionStartEvent["reason"]): Promise<void> {
	const event: SessionStartEvent = { type: "session_start", reason };
	await emit(events, "session_start", event);
}

async function emitSessionShutdown(events: EventHandlers, reason: SessionShutdownEvent["reason"]): Promise<void> {
	const event: SessionShutdownEvent = { type: "session_shutdown", reason };
	await emit(events, "session_shutdown", event);
}

async function emit(events: EventHandlers, name: string, event: unknown): Promise<void> {
	for (const handler of events.get(name) ?? []) {
		await handler(event, {} as ExtensionContext);
	}
}
