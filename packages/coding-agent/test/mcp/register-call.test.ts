import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertJsonSchemaToTypeBox } from "../../src/core/extensions/builtin/mcp/expose/schema-compat.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import {
	attach,
	capturingPi,
	expectFileToContain,
	mcpRoot as makeMcpRoot,
	mcpExtensionFor,
	readSchemaFixture,
	registeredTool,
	testContext,
	textContent,
	toolResultTexts,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string) {
	return makeMcpRoot(slug, cleanupTasks);
}

describe("MCP catalog + registerTool bridge", () => {
	it("registers a five-tool fixture server as stable mcp_fx_* tools", async () => {
		const root = mcpRoot("five-tools");
		setConfig(root, { fx: stdioServer(["--tools", "5"]) });
		const pi = capturingPi();

		await attach(root, pi);

		expect(pi.registeredTools).toEqual([
			"mcp_fx_tool_1",
			"mcp_fx_tool_2",
			"mcp_fx_tool_3",
			"mcp_fx_tool_4",
			"mcp_fx_tool_5",
		]);
		expect(pi.activeTools).toEqual(pi.registeredTools);
	});

	it("runs a model turn through the registered MCP tool and returns fixture payload", async () => {
		const root = mcpRoot("model-call");
		setConfig(root, { fx: stdioServer(["--tools", "5"]) });
		const providerToolNames: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [mcpExtensionFor(root.agentDir)],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
				return fauxAssistantMessage(fauxToolCall("mcp_fx_tool_1", { value: "ok" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("call fixture tool 1");

		expect(providerToolNames[0]).toEqual(
			expect.arrayContaining(["mcp_fx_tool_1", "mcp_fx_tool_2", "mcp_fx_tool_3", "mcp_fx_tool_4", "mcp_fx_tool_5"]),
		);
		expect(toolResultTexts(harness, "mcp_fx_tool_1")).toEqual(["fixture tool_1 value=ok mode=alpha"]);
	});

	it("surfaces MCP isError as an exact model-visible tool error result", async () => {
		const root = mcpRoot("iserror");
		setConfig(root, { fx: stdioServer(["--tools", "0", "--iserror-tool"]) });
		const harness = await createHarness({ extensionFactories: [mcpExtensionFor(root.agentDir)] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp_fx_iserror_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued after error"),
		]);

		await harness.session.prompt("call error tool");

		expect(toolResultTexts(harness, "mcp_fx_iserror_tool")).toEqual(["fixture isError result"]);
		const errorEvents = harness
			.eventsOfType("tool_execution_end")
			.filter((event) => event.toolName === "mcp_fx_iserror_tool");
		expect(errorEvents).toEqual([expect.objectContaining({ isError: true })]);
	});

	it("converts a huge MCP input schema without dropping supported keywords", async () => {
		const root = mcpRoot("huge-schema");
		setConfig(root, { fx: stdioServer(["--tools", "0", "--huge-schema-tool"]) });
		const pi = capturingPi();

		await attach(root, pi);

		const tool = registeredTool(pi, "mcp_fx_huge_schema_tool");
		const expected = convertJsonSchemaToTypeBox(readSchemaFixture("nasty-input.schema.json"));
		expect(expected.warnings).toEqual([]);
		expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(JSON.parse(JSON.stringify(expected.schema)));
	});

	it("routes AbortSignal cancellation to the fixture request", async () => {
		const root = mcpRoot("abort");
		const cancelLog = join(root.agentDir, "cancel-log.txt");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--slow-tool-call", "2000", "--cancel-log", cancelLog]) });
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");
		const controller = new AbortController();
		let sawProgress = (): void => {};
		const progress = new Promise<void>((resolve) => {
			sawProgress = resolve;
		});

		const running = tool.execute(
			"tc-abort",
			{ value: "abort" },
			controller.signal,
			() => sawProgress(),
			testContext(),
		);
		await progress;
		controller.abort();

		await expect(running).rejects.toThrow(/abort|cancel/i);
		await expectFileToContain(cancelLog, "cancelled tool_1");
	});

	it("allows two concurrent calls to the same server connection", async () => {
		const root = mcpRoot("concurrent");
		setConfig(root, { fx: stdioServer(["--tools", "1", "--slow-tool-call", "50"]) });
		const pi = capturingPi();
		await attach(root, pi);
		const tool = registeredTool(pi, "mcp_fx_tool_1");

		const [first, second] = await Promise.all([
			tool.execute("tc-1", { value: "first" }, undefined, undefined, testContext()),
			tool.execute("tc-2", { value: "second" }, undefined, undefined, testContext()),
		]);

		expect(textContent(first)).toBe("fixture tool_1 value=first mode=alpha");
		expect(textContent(second)).toBe("fixture tool_1 value=second mode=alpha");
	});

	it("keeps non-promoted registered tools out of provider payloads", async () => {
		const root = mcpRoot("active-subset");
		setConfig(root, { fx: stdioServer(["--tools", "5"]) });
		const providerToolNames: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [mcpExtensionFor(root.agentDir, ["mcp_fx_tool_1"])],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("only promoted tool should be exposed");

		expect(harness.session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["mcp_fx_tool_1", "mcp_fx_tool_2", "mcp_fx_tool_5"]),
		);
		expect(providerToolNames).toEqual([["mcp_fx_tool_1"]]);
	});
});
