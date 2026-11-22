// A search-mode MCP tool the model loaded through tool_search stays callable
// after the session is resumed in a new process, even though the MCP server
// reconnects after the session restored its tool loadout. Reload replays the
// same history on attach (rehydration-wiring.test.ts).
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import {
	attachHarnessSession,
	awaitMcpToolRegistration,
	mcpRoot as makeMcpRoot,
	mcpExtensionFor,
	toolResultTexts,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

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

async function harnessFor(root: TestRoot, sessionManager?: Harness["sessionManager"]): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [{ factory: mcpExtensionFor(root.agentDir), path: "<builtin:mcp>" }],
		...(sessionManager === undefined ? {} : { sessionManager }),
	});
	harnesses.push(harness);
	return harness;
}

async function loadToolThroughToolSearch(root: TestRoot): Promise<Harness> {
	setConfig(root, { fx: { ...stdioServer(["--tools", "3"]), exposure: "search" } });
	const harness = await harnessFor(root);
	await attachHarnessSession(harness, "fx");
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("tool_search", { query: "tool 2" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("mcp_fx_tool_2", { value: "first" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("find and call tool 2");
	expect(toolResultTexts(harness, "mcp_fx_tool_2")).toEqual(["fixture tool_2 value=first mode=alpha"]);
	return harness;
}

async function callToolAgain(harness: Harness): Promise<void> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("mcp_fx_tool_2", { value: "again" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done again"),
	]);
	await harness.session.prompt("call tool 2 again");
}

function toolErrors(harness: Harness): number {
	return harness
		.eventsOfType("tool_execution_end")
		.filter((event) => event.toolName === "mcp_fx_tool_2" && event.isError).length;
}

describe("MCP tools loaded by tool_search across resume", () => {
	it("stays callable after the session is resumed by a new process", async () => {
		const root = makeMcpRoot("resume-loaded", cleanupTasks);
		const first = await loadToolThroughToolSearch(root);
		await getMcpService().dispose("quit");
		resetMcpServiceForTests();

		const resumed = await harnessFor(root, first.sessionManager);
		await resumed.getExtensionRunner().emit({ type: "session_start", reason: "resume" });
		await awaitMcpToolRegistration("fx");
		await callToolAgain(resumed);

		expect(toolResultTexts(resumed, "mcp_fx_tool_2")).toEqual([
			"fixture tool_2 value=first mode=alpha",
			"fixture tool_2 value=again mode=alpha",
		]);
		expect(toolErrors(resumed)).toBe(0);
	});
});
