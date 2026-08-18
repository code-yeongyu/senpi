import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ToolSearchDocument } from "../../src/core/extensions/builtin/tool-search/engine/document.ts";
import { emitActivationMarker } from "../../src/core/extensions/builtin/tool-search/engine/marker.ts";
import { createToolSearchExtension } from "../../src/core/extensions/builtin/tool-search/index.ts";
import { type ToolSearchRuntime, ToolSearchService } from "../../src/core/extensions/builtin/tool-search/service.ts";
import { createToolSearchTool } from "../../src/core/extensions/builtin/tool-search/tool.ts";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolInfo,
} from "../../src/core/extensions/types.ts";

function toolInfo(name: string, overrides: Partial<ToolInfo> = {}): ToolInfo {
	return {
		name,
		label: `Label for ${name}`,
		description: `Description for ${name}`,
		parameters: Type.Object({}),
		sourceInfo: {
			path: `/workspace/extensions/weather-tools.ts`,
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
		exposure: "search",
		searchKeywords: [],
		allowLazyActivation: true,
		...overrides,
	};
}

function document(name: string, source: "mcp" | "extension" = "mcp"): ToolSearchDocument {
	return {
		name,
		label: `Label for ${name}`,
		aliases: [],
		description: `${name} calendar scheduling capability`,
		keywords: [],
		source,
		group: source === "mcp" ? "calendar-server" : "weather-tools",
		ownerLabel: source === "mcp" ? "calendar-server" : "weather-tools",
		registrationId: `${source}\0owner\0${name}`,
	};
}

function runtime(
	tools: ToolInfo[] = [],
	initiallyActive: string[] = [],
): {
	runtime: ToolSearchRuntime;
	active: string[];
	setActiveTools: ReturnType<typeof vi.fn>;
} {
	const active = [...initiallyActive];
	const setActiveTools = vi.fn((names: readonly string[]) => {
		active.splice(0, active.length, ...names);
	});
	return {
		runtime: {
			getAllTools: () => tools,
			getActiveTools: () => [...active],
			setActiveTools,
		},
		active,
		setActiveTools,
	};
}

describe("ToolSearchService", () => {
	it("registers tool_search only after the catalog gains a searchable document", () => {
		const state = runtime([], ["read"]);
		const service = new ToolSearchService(state.runtime);
		const register = vi.fn();

		service.bindToolRegistrar(register);
		expect(register).not.toHaveBeenCalled();
		expect(state.active).toEqual(["read"]);

		service.feed("mcp", [document("mcp_calendar_create")], { activate: vi.fn() });
		expect(register).toHaveBeenCalledOnce();
		expect(state.active).toEqual(["read", "tool_search"]);

		service.feed("mcp", [], { activate: vi.fn() });
		expect(register).toHaveBeenCalledOnce();
		expect(state.active).toEqual(["read"]);
	});

	it("ranks fed documents and invokes the owning hook for every match, including an active stub", () => {
		const state = runtime([], ["mcp_calendar_stub"]);
		const service = new ToolSearchService(state.runtime);
		const activate = vi.fn((names: readonly string[]) => {
			state.runtime.setActiveTools([
				...state.runtime.getActiveTools(),
				...names.filter((name) => !state.active.includes(name)),
			]);
		});
		service.feed("mcp", [document("mcp_calendar_stub"), document("mcp_calendar_create"), document("mcp_unrelated")], {
			activate,
		});

		const matches = service.search("calendar scheduling", 2, { source: "mcp" });
		const activated = service.activate(matches);

		expect(matches.map(({ name }) => name)).toEqual(["mcp_calendar_create", "mcp_calendar_stub"]);
		expect(activate).toHaveBeenCalledOnce();
		expect(activate).toHaveBeenCalledWith(["mcp_calendar_create", "mcp_calendar_stub"]);
		expect(activated).toEqual(["mcp_calendar_create", "mcp_calendar_stub"]);
	});

	it("ingests live extension metadata and excludes lazy-activation-gated and malformed documents", () => {
		const tools = [
			toolInfo("weather_forecast", {
				label: "Weather Forecast",
				searchText: "hourly rain and temperature",
				searchKeywords: ["meteorology"],
			}),
			toolInfo("private_forecast", { allowLazyActivation: false }),
			toolInfo("direct_tool", { exposure: "direct" }),
		];
		const state = runtime(tools);
		const service = new ToolSearchService(state.runtime);
		service.feed(
			"mcp",
			[
				document("valid"),
				{ ...document("missing_name"), name: "" },
				{ ...document("missing_registration"), registrationId: "" },
			],
			{ activate: vi.fn() },
		);

		expect(service.getCatalog()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "weather_forecast",
					label: "Weather Forecast",
					aliases: [],
					searchText: "hourly rain and temperature",
					keywords: ["meteorology"],
					source: "extension",
					group: "weather-tools",
					ownerLabel: "weather-tools",
					registrationId: "/workspace/extensions/weather-tools.ts\0weather_forecast",
				}),
			]),
		);
		expect(service.getCatalog().map(({ name }) => name)).toEqual(["valid", "weather_forecast"]);
		expect(service.getCatalog().map(({ name }) => name)).not.toContain("private_forecast");
		expect(service.search("   ")).toEqual([]);
	});

	it("rehydrates extension v2 markers once per catalog generation", () => {
		const tools = [toolInfo("weather_forecast")];
		const state = runtime(tools);
		const service = new ToolSearchService(state.runtime);
		const marker = emitActivationMarker([
			{
				name: "weather_forecast",
				registrationId: "/workspace/extensions/weather-tools.ts\0weather_forecast",
			},
		]);

		expect(service.maybeRehydrateFromHistory([{ content: marker }])).toEqual(["weather_forecast"]);
		expect(state.active).toEqual(["tool_search", "weather_forecast"]);
		expect(service.maybeRehydrateFromHistory([{ content: marker }])).toEqual([]);
		expect(state.setActiveTools).toHaveBeenCalledTimes(2);

		tools.push(toolInfo("weather_alerts"));
		expect(service.maybeRehydrateFromHistory([{ content: marker }])).toEqual(["weather_forecast"]);
		expect(state.setActiveTools).toHaveBeenCalledTimes(3);
	});

	it("authors legacy server argument mapping without registering tool_search", async () => {
		const state = runtime([], ["read", "bash"]);
		const definition = createToolSearchTool(new ToolSearchService(state.runtime));

		expect(definition.prepareArguments?.({ query: "calendar", server: "office" })).toEqual({
			query: "calendar",
			source: "mcp",
			group: "office",
		});
		expect(
			definition.prepareArguments?.({ query: "weather", source: "extension", group: "plugins", server: "ignored" }),
		).toEqual({ query: "weather", source: "extension", group: "plugins" });

		const result = await definition.execute(
			"call-1",
			{ query: "nothing matches" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("No tools matched") }),
		]);
		expect(state.active).toEqual(["read", "bash"]);
		expect(state.setActiveTools).not.toHaveBeenCalled();
	});

	it("registers shared wiring, catalogs extension tools, lazily promotes, and rehydrates session history", async () => {
		const tools = [toolInfo("weather_forecast")];
		const state = runtime(tools);
		const service = new ToolSearchService(state.runtime);
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
		let activator: ((name: string) => boolean) | undefined;
		const pi = {
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerLazyToolActivator(handler: (name: string) => boolean) {
				activator = handler;
			},
			getAllTools: state.runtime.getAllTools,
			getActiveTools: state.runtime.getActiveTools,
			setActiveTools: (names: string[]) => state.runtime.setActiveTools(names),
			registerTool: vi.fn(),
		} as unknown as ExtensionAPI;
		createToolSearchExtension(service)(pi);
		const marker = emitActivationMarker([
			{
				name: "weather_forecast",
				registrationId: "/workspace/extensions/weather-tools.ts\0weather_forecast",
			},
		]);
		const ctx = {
			sessionManager: { getEntries: () => [{ content: marker }] },
		} as unknown as ExtensionContext;

		for (const handler of handlers.get("session_start") ?? []) {
			handler({ type: "session_start", reason: "resume" } satisfies SessionStartEvent, ctx);
		}
		expect(pi.registerTool).toHaveBeenCalledOnce();
		expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "tool_search" }));
		expect(service.getCatalog()).toEqual([
			expect.objectContaining({ name: "weather_forecast", source: "extension" }),
		]);
		expect(state.active).toContain("weather_forecast");

		state.runtime.setActiveTools([]);
		expect(activator?.("weather_forecast")).toBe(true);
		expect(state.active).toEqual(["weather_forecast"]);
		const callsBeforeContext = state.setActiveTools.mock.calls.length;
		for (const handler of handlers.get("context") ?? []) {
			handler(
				{ type: "context", messages: [{ role: "user", content: marker, timestamp: 0 }] } satisfies ContextEvent,
				ctx,
			);
		}
		// The context event is in the same catalog generation as session_start,
		// so stale history is not applied a second time.
		expect(state.setActiveTools).toHaveBeenCalledTimes(callsBeforeContext);

		const feedActivate = vi.fn((names: readonly string[]) => {
			state.runtime.setActiveTools([...state.runtime.getActiveTools(), ...names]);
		});
		service.feed("mcp", [document("mcp_calendar_create")], { activate: feedActivate });
		service.activate(service.search("mcp_calendar_create", 10, { source: "mcp" }));
		expect(feedActivate).toHaveBeenCalledWith(["mcp_calendar_create"]);
		expect(state.active).toContain("mcp_calendar_create");

		if (process.env.TOOL_SEARCH_QA === "1") {
			console.log(
				JSON.stringify({
					toolSearchRegistered: (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.length > 0,
					toolSearchActive: state.active.includes("tool_search"),
					extensionDoc: service.getCatalog().find(({ name }) => name === "weather_forecast"),
					feedActivation: { calls: feedActivate.mock.calls, active: state.active },
					rehydrated: state.active.includes("weather_forecast"),
					secondContextApplied: state.setActiveTools.mock.calls.length !== callsBeforeContext + 1,
				}),
			);
		}
	});
});
