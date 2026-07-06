import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, capturingPi, mcpRoot as makeMcpRoot } from "./fixtures/register-call.ts";
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
		expect(includePi.activeTools).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_3"]);

		const excludeRoot = mcpRoot("exclude-only");
		setConfig(excludeRoot, { fx: { ...stdioServer(["--tools", "5"]), excludeTools: ["tool_[24]"] } });
		const excludePi = capturingPi();
		await attach(excludeRoot, excludePi);
		expect(excludePi.activeTools).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_3", "mcp_fx_tool_5"]);

		const bothRoot = mcpRoot("include-exclude");
		setConfig(bothRoot, {
			fx: { ...stdioServer(["--tools", "5"]), excludeTools: ["tool_3"], includeTools: ["tool_[1-3]"] },
		});
		const bothPi = capturingPi();
		await attach(bothRoot, bothPi);
		expect(bothPi.activeTools).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2"]);

		const starRoot = mcpRoot("star");
		setConfig(starRoot, { fx: { ...stdioServer(["--tools", "5"]), excludeTools: ["tool_5"], includeTools: ["*"] } });
		const starPi = capturingPi();
		await attach(starRoot, starPi);
		expect(starPi.activeTools).toEqual(["mcp_fx_tool_1", "mcp_fx_tool_2", "mcp_fx_tool_3", "mcp_fx_tool_4"]);
	});

	it("uses the default threshold boundary: 10 filtered tools direct, 11 filtered tools W1 direct with warning", async () => {
		const tenRoot = mcpRoot("threshold-10");
		setConfig(tenRoot, { fx: stdioServer(["--tools", "10"]) });
		const tenPi = capturingPi();
		await attach(tenRoot, tenPi);
		expect(tenPi.registeredTools).toEqual(toolNames(10));
		expect(tenPi.activeTools).toEqual(toolNames(10));

		const elevenRoot = mcpRoot("threshold-11");
		setConfig(elevenRoot, { fx: stdioServer(["--tools", "11"]) });
		const elevenPi = capturingPi();
		await attach(elevenRoot, elevenPi);
		expect(elevenPi.registeredTools).toEqual(toolNames(11));
		expect(elevenPi.activeTools).toEqual(toolNames(11));
		expect(logContains("fx", "pending-W4")).toBe(true);
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

		expect(pi.activeTools).toEqual(["bash", "mcp_fx_tool_1", "mcp_fx_tool_12", "mcp_fx_tool_2"]);
		expect(pi.setActiveCalls[pi.setActiveCalls.length - 1]).toEqual([
			"bash",
			"mcp_fx_tool_1",
			"mcp_fx_tool_12",
			"mcp_fx_tool_2",
		]);
	});

	it("registers all tools for a 30-tool W1 fixture and logs a warning instead of silently dropping tools", async () => {
		const root = mcpRoot("large-w1");
		setConfig(root, { fx: stdioServer(["--tools", "30"]) });
		const pi = capturingPi();

		await attach(root, pi);

		expect(pi.registeredTools).toEqual(toolNames(30));
		expect(pi.activeTools).toEqual(toolNames(30));
		expect(logContains("fx", "pending-W4")).toBe(true);
	});

	it("treats an includeTools filter matching zero tools as a non-error zero-exposure result", async () => {
		const root = mcpRoot("zero-match");
		setConfig(root, { fx: { ...stdioServer(["--tools", "5"]), includeTools: ["missing_*"] } });
		const pi = capturingPi(["bash", "mcp_fx_tool_1"]);

		await attach(root, pi);

		expect(pi.registeredTools).toEqual([]);
		expect(pi.activeTools).toEqual(["bash"]);
		expect(pi.setActiveCalls).toEqual([["bash"]]);
		expect(logContains("fx", "0 exposed")).toBe(true);
	});
});
