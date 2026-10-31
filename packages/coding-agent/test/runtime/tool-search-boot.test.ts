import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import {
	getToolSearchServiceForExtension,
	type ToolSearchService,
} from "../../src/core/extensions/builtin/tool-search/service.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../../src/core/extensions/builtin/tool-search/tool.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI, LoadExtensionsResult, ToolDefinition } from "../../src/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

function deferredTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} looks up stored records`,
		exposure: "search",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

const open: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of open.splice(0)) harness.cleanup();
});

interface Booted {
	harness: Harness;
	service: ToolSearchService;
	extensionsResult: LoadExtensionsResult;
}

async function runtimeWithoutSessionStart(tools: readonly string[]): Promise<Booted> {
	let toolSearchPi: ExtensionAPI | undefined;
	const extensionsResult = await createTestExtensionsResult([
		{
			path: "<builtin:tool-search>",
			factory: (pi) => {
				toolSearchPi = pi;
				return toolSearchExtension(pi);
			},
		},
		{
			path: "/extensions/records.ts",
			factory: (pi) => {
				for (const name of tools) pi.registerTool(deferredTool(name));
			},
		},
	]);
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
	open.push(harness);
	if (toolSearchPi === undefined) throw new Error("tool-search did not load");
	const service = getToolSearchServiceForExtension(toolSearchPi);
	if (service === undefined) throw new Error("tool-search registered no service");
	return { harness, service, extensionsResult };
}

function toolCall(runner: ExtensionRunner, id: string) {
	return runner.emitToolCall({ type: "tool_call", toolName: "read", input: { path: "a.txt" }, toolCallId: id });
}

describe("tool_search boots without a session start (RT5a)", () => {
	it("boots the catalog at the first tool call and turns tool_search on", async () => {
		// Given a runtime that loaded a searchable tool and never emitted session_start.
		const { harness } = await runtimeWithoutSessionStart(["records_lookup"]);
		// When its first tool call arrives.
		await toolCall(harness.getExtensionRunner(), "call-1");
		// Then the resident tool_search is registered and active.
		expect(harness.session.getAllTools().map(({ name }) => name)).toContain(TOOL_SEARCH_TOOL_NAME);
		expect(harness.session.getActiveToolNames()).toContain(TOOL_SEARCH_TOOL_NAME);
	});

	it("finds and activates a searchable tool after booting", async () => {
		const { harness, service } = await runtimeWithoutSessionStart(["records_lookup", "records_archive"]);
		await toolCall(harness.getExtensionRunner(), "call-1");
		const matches = service.search("records_lookup", 1);
		expect(matches.map(({ name }) => name)).toEqual(["records_lookup"]);
		expect(service.activate(matches)).toEqual(["records_lookup"]);
		expect(harness.session.getActiveToolNames()).toContain("records_lookup");
		expect(harness.session.getActiveToolNames()).not.toContain("records_archive");
	});

	it("keeps tool_search off when nothing is searchable", async () => {
		const { harness } = await runtimeWithoutSessionStart([]);
		await toolCall(harness.getExtensionRunner(), "call-1");
		expect(harness.session.getActiveToolNames()).not.toContain(TOOL_SEARCH_TOOL_NAME);
	});

	it("does nothing at a tool call once session_start booted the context", async () => {
		// Given a session whose session_start already booted the catalog.
		const { harness, service } = await runtimeWithoutSessionStart(["records_lookup"]);
		const runner = harness.getExtensionRunner();
		await runner.emit({ type: "session_start", reason: "startup" });
		const getCatalog = vi.spyOn(service, "getCatalog");
		// When tool calls arrive.
		await toolCall(runner, "call-1");
		await toolCall(runner, "call-2");
		// Then the first-use boot never runs on the session path.
		expect(getCatalog).not.toHaveBeenCalled();
	});

	it("boots once for a runtime whose contexts have no session manager", async () => {
		// Given a runner without a session manager over a runtime that can list its tools.
		const { harness, service, extensionsResult } = await runtimeWithoutSessionStart(["records_lookup"]);
		const runtime = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			process.cwd(),
			undefined,
			harness.session.modelRegistry,
			extensionsResult.eventBus,
		);
		const getCatalog = vi.spyOn(service, "getCatalog");
		const added = vi.spyOn(WeakSet.prototype, "add");
		// When tool calls arrive.
		await toolCall(runtime, "call-1");
		await toolCall(runtime, "call-2");
		// Then the runtime booted once, and no undefined key reached a WeakSet.
		expect(getCatalog).toHaveBeenCalledTimes(1);
		expect(added.mock.calls.some(([value]) => value === undefined)).toBe(false);
	});

	it("defers the boot without failing the call while the runtime cannot list its tools", async () => {
		// Given a runner without a session manager whose runtime core is not bound.
		const extensionsResult = await createTestExtensionsResult([
			{ path: "<builtin:tool-search>", factory: toolSearchExtension },
		]);
		const runtime = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			process.cwd(),
			undefined,
			(await runtimeWithoutSessionStart([])).harness.session.modelRegistry,
			extensionsResult.eventBus,
		);
		// Then its tool calls pass through tool-search untouched.
		await expect(toolCall(runtime, "call-1")).resolves.toBeUndefined();
		await expect(toolCall(runtime, "call-2")).resolves.toBeUndefined();
	});

	it("boots each context once", async () => {
		// Given one extension load seen through two contexts with no session start.
		const { harness, service, extensionsResult } = await runtimeWithoutSessionStart(["records_lookup"]);
		const first = harness.getExtensionRunner();
		const second = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			process.cwd(),
			SessionManager.inMemory(process.cwd()),
			harness.session.modelRegistry,
			extensionsResult.eventBus,
		);
		const getCatalog = vi.spyOn(service, "getCatalog");
		// When each context sees tool calls.
		await toolCall(first, "call-1");
		await toolCall(first, "call-2");
		await toolCall(second, "call-3");
		await toolCall(second, "call-4");
		// Then each context booted exactly once.
		expect(getCatalog).toHaveBeenCalledTimes(2);
	});
});
