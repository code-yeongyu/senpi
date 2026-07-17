import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, capturingPi, mcpRoot as makeMcpRoot, withoutMcpUtilityTools } from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string) {
	return makeMcpRoot(`exposure-policy-${slug}`, cleanupTasks);
}

function toolNames(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `mcp_fx_tool_${index + 1}`).sort();
}

function logContains(serverName: string, text: string): boolean {
	return getMcpService()
		.getLogLines(serverName, 20)
		.some((line: string) => line.includes(text));
}

describe("MCP Tier-A exposure policy", () => {
	it("applies include-only, exclude-only, include+exclude, and star glob filters with exclude winning", async () => {
		const includeRoot = mcpRoot("include-only");
		setConfig(includeRoot, { fx: { ...stdioServer(["--tools", "5"]), includeTools: ["tool_[13]"] } });
		const includePi = capturingPi();
		await attach(includeRoot, includePi);
		expect(withoutMcpUtilityTools(includePi.activeTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_3"]);

		const excludeRoot = mcpRoot("exclude-only");
		setConfig(excludeRoot, { fx: { ...stdioServer(["--tools", "5"]), excludeTools: ["tool_[24]"] } });
		const excludePi = capturingPi();
		await attach(excludeRoot, excludePi);
		expect(withoutMcpUtilityTools(excludePi.activeTools)).toEqual([
			"mcp_fx_tool_1",
			"mcp_fx_tool_3",
			"mcp_fx_tool_5",
		]);

		const bothRoot = mcpRoot("include-exclude");
		setConfig(bothRoot, {
			fx: { ...stdioServer(["--tools", "5"]), excludeTools: ["tool_3"], includeTools: ["tool_[1-3]"] },
		});
		const bothPi = capturingPi();
		await attach(bothRoot, bothPi);
		expect(withoutMcpUtilityTools(bothPi.activeTools)).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);

		const starRoot = mcpRoot("star");
		setConfig(starRoot, { fx: { ...stdioServer(["--tools", "5"]), excludeTools: ["tool_5"], includeTools: ["*"] } });
		const starPi = capturingPi();
		await attach(starRoot, starPi);
		expect(withoutMcpUtilityTools(starPi.activeTools)).toEqual([
			"mcp_fx_tool_1",
			"mcp_fx_tool_2",
			"mcp_fx_tool_3",
			"mcp_fx_tool_4",
		]);
	});

	it("flips at the threshold boundary: 10 filtered tools direct, 11 filtered tools -> search mode", async () => {
		const tenRoot = mcpRoot("threshold-10");
		setConfig(tenRoot, { fx: stdioServer(["--tools", "10"]) });
		const tenPi = capturingPi();
		await attach(tenRoot, tenPi);
		expect(withoutMcpUtilityTools(tenPi.registeredTools)).toEqual(toolNames(10));
		expect(withoutMcpUtilityTools(tenPi.activeTools)).toEqual(toolNames(10));

		const elevenRoot = mcpRoot("threshold-11");
		setConfig(elevenRoot, { fx: stdioServer(["--tools", "11"]) });
		const elevenPi = capturingPi();
		await attach(elevenRoot, elevenPi);
		// All 11 tools are registered (catalog present) plus tool_search...
		expect([...withoutMcpUtilityTools(elevenPi.registeredTools)].sort()).toEqual(
			[...toolNames(11), "tool_search"].sort(),
		);
		// ...but only tool_search is active: the 11 tools cost zero tokens until promoted.
		expect(withoutMcpUtilityTools(elevenPi.activeTools)).toEqual(["tool_search"]);
		// The W1 pending-W4 warning fallback is gone.
		expect(logContains("fx", "pending-W4")).toBe(false);
	});

	it("promotes directTools matches while keeping the policy result deterministic and stable-sorted", async () => {
		const root = mcpRoot("direct-tools");
		setConfig(root, {
			fx: {
				...stdioServer(["--tools", "12"]),
				directTools: ["tool_12", "tool_2", "tool_1"],
				exposure: "search",
			},
		});
		const pi = capturingPi(["bash"]);

		await attach(root, pi);

		// Search mode keeps directTools active alongside the always-active tool_search.
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual([
			"bash",
			"tool_search",
			"mcp_fx_tool_1",
			"mcp_fx_tool_12",
			"mcp_fx_tool_2",
		]);
		expect(withoutMcpUtilityTools(pi.setActiveCalls[pi.setActiveCalls.length - 1])).toEqual([
			"bash",
			"tool_search",
			"mcp_fx_tool_1",
			"mcp_fx_tool_12",
			"mcp_fx_tool_2",
		]);
	});

	it("registers a 30-tool fixture in search mode: full catalog registered, only tool_search active", async () => {
		const root = mcpRoot("large-search");
		setConfig(root, { fx: stdioServer(["--tools", "30"]) });
		const pi = capturingPi();

		await attach(root, pi);

		expect([...withoutMcpUtilityTools(pi.registeredTools)].sort()).toEqual([...toolNames(30), "tool_search"].sort());
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["tool_search"]);
		expect(logContains("fx", "pending-W4")).toBe(false);
	});

	it("treats an includeTools filter matching zero tools as a non-error zero-exposure result", async () => {
		const root = mcpRoot("zero-match");
		setConfig(root, { fx: { ...stdioServer(["--tools", "5"]), includeTools: ["missing_*"] } });
		const pi = capturingPi(["bash", "mcp_fx_tool_1"]);

		await attach(root, pi);

		expect(withoutMcpUtilityTools(pi.registeredTools)).toEqual([]);
		expect(withoutMcpUtilityTools(pi.activeTools)).toEqual(["bash"]);
		expect(pi.setActiveCalls.map((call) => withoutMcpUtilityTools(call))).toEqual([["bash"]]);
		expect(logContains("fx", "0 exposed")).toBe(true);
	});
});
