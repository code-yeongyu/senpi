import { describe, expect, it, vi } from "vitest";
import type { ToolSearchDocument } from "../../src/core/extensions/builtin/tool-search/engine/document.ts";
import { ToolSearchService } from "../../src/core/extensions/builtin/tool-search/service.ts";

const SEARCHABLE: ToolSearchDocument[] = [
	{
		name: "mcp_computer_use_click",
		label: "click",
		aliases: ["click"],
		description: "click the computer screen",
		keywords: [],
		source: "mcp",
		group: "computer_use",
		ownerLabel: "computer_use",
		registrationId: "mcp\0computer_use\0click",
	},
	{
		name: "mcp_computer_use_batch",
		label: "batch",
		aliases: ["batch"],
		description: "batch computer actions",
		keywords: [],
		source: "mcp",
		group: "computer_use",
		ownerLabel: "computer_use",
		registrationId: "mcp\0computer_use\0batch",
	},
];

function serviceState(activeNames: string[] = ["read", "bash"]) {
	const active = [...activeNames];
	const activate = vi.fn((names: readonly string[]) => {
		for (const name of names) if (!active.includes(name)) active.push(name);
	});
	const service = new ToolSearchService({
		getAllTools: () => [],
		getActiveTools: () => [...active],
		setActiveTools: (names) => active.splice(0, active.length, ...names),
	});
	service.feed("mcp", SEARCHABLE, { activate });
	return { activate, active, service };
}

describe("shared-service MCP lazy activation", () => {
	it("selects a searchable tool that is registered but inactive", () => {
		const state = serviceState();
		expect(state.service.activateTool("mcp_computer_use_click")).toBe(true);
		expect(state.active).toContain("mcp_computer_use_click");
	});

	it("routes an already-active searchable name through the feeder for stub swapping", () => {
		const state = serviceState(["read", "mcp_computer_use_click"]);
		expect(state.service.activateTool("mcp_computer_use_click")).toBe(true);
		expect(state.activate).toHaveBeenCalledWith(["mcp_computer_use_click"]);
	});

	it("refuses a tool outside the searchable catalog", () => {
		const state = serviceState();
		expect(state.service.activateTool("look_at")).toBe(false);
		expect(state.activate).not.toHaveBeenCalled();
	});

	it("refuses an unknown tool", () => {
		const state = serviceState();
		expect(state.service.activateTool("nope")).toBe(false);
		expect(state.activate).not.toHaveBeenCalled();
	});

	it("activates multiple ranked MCP matches in one feeder batch", () => {
		const state = serviceState();
		const matches = state.service.search("computer", 10, { source: "mcp" });
		expect(state.service.activate(matches)).toEqual(["mcp_computer_use_batch", "mcp_computer_use_click"]);
		expect(state.activate).toHaveBeenCalledOnce();
		expect(state.activate).toHaveBeenCalledWith(["mcp_computer_use_batch", "mcp_computer_use_click"]);
	});

	it("returns true only after the feeder makes the requested name active", () => {
		const active = ["read"];
		const service = new ToolSearchService({
			getAllTools: () => [],
			getActiveTools: () => [...active],
			setActiveTools: (names) => active.splice(0, active.length, ...names),
		});
		service.feed("mcp", SEARCHABLE, { activate: vi.fn() });
		expect(service.activateTool("mcp_computer_use_click")).toBe(false);
	});

	it("never calls the feeder for an ineligible tool", () => {
		const state = serviceState();
		expect(state.service.activateTool("look_at")).toBe(false);
		expect(state.activate).not.toHaveBeenCalled();
	});
});
