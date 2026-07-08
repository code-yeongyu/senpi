// Tier-C proxy mode (todo 38): `exposure:"proxy"` hides a server's whole
// catalog behind ONE always-active gateway tool (search/describe/call with
// JSON-string args); user mistakes come back as guiding text, unknown tools
// get nearest-match hints, and auto NEVER selects proxy.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { computeMcpExposurePolicy } from "../../src/core/extensions/builtin/mcp/expose/policy.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	attach,
	capturingPi,
	mcpRoot as makeMcpRoot,
	registeredTool,
	testContext,
	textContent,
	withoutMcpUtilityTools,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

describe("tier-C proxy mode", () => {
	it("exposes exactly one gateway; search/describe/call round-trip; bad args guide the model", async () => {
		const root = mcpRoot("proxy-live");
		setConfig(root, { fx: { ...stdioServer(["--tools", "5"]), exposure: "proxy" } });
		const pi = capturingPi();
		await attach(root, pi);

		const mcpActive = withoutMcpUtilityTools(pi.getActiveTools()).filter((name) => name.startsWith("mcp_"));
		expect(mcpActive).toEqual(["mcp_fx"]);
		expect(withoutMcpUtilityTools(pi.registeredTools).filter((name) => name.startsWith("mcp_fx_"))).toEqual([]);

		const gateway = registeredTool(pi, "mcp_fx");
		const search = await gateway.execute(
			"tc-s",
			{ op: "search", query: "generated fixture tool 2" },
			undefined,
			undefined,
			testContext(),
		);
		expect(textContent(search)).toContain("tool_2");

		const describe = await gateway.execute(
			"tc-d",
			{ op: "describe", tool: "tool_2" },
			undefined,
			undefined,
			testContext(),
		);
		expect(textContent(describe)).toContain("Input schema");

		const call = await gateway.execute(
			"tc-c",
			{ args: '{"value":"via-proxy"}', op: "call", tool: "tool_2" },
			undefined,
			undefined,
			testContext(),
		);
		expect(textContent(call)).toBe("fixture tool_2 value=via-proxy mode=alpha");

		const badArgs = await gateway.execute(
			"tc-b",
			{ args: "{not json", op: "call", tool: "tool_2" },
			undefined,
			undefined,
			testContext(),
		);
		expect(textContent(badArgs)).toContain("JSON object STRING");

		const unknown = await gateway.execute(
			"tc-u",
			{ op: "call", tool: "tool_99x" },
			undefined,
			undefined,
			testContext(),
		);
		expect(textContent(unknown)).toContain("Unknown tool");
		expect(textContent(unknown)).toContain("Nearest matches");
	});

	it("auto exposure never selects proxy", () => {
		const entries = Array.from({ length: 40 }, (_, index) => ({
			description: `tool ${index}`,
			schema: {},
			server: "big",
			tool: `tool_${index}`,
		}));
		const policy = computeMcpExposurePolicy(
			entries as never,
			{ exposure: "auto" } as never,
			defaultSettings as never,
		);
		expect(policy.mode).not.toBe("proxy");
	});
});
