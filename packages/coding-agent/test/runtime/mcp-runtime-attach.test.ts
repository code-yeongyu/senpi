import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import mcpExtension from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { ExtensionRunner, noOpUIContext } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { RuntimeUiBroker } from "../../src/core/runtime/ui-broker.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer, type TestRoot } from "../mcp/fixtures/service-lifecycle.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	await cleanupRoots(cleanupTasks);
});

function rootWithServer(slug: string): TestRoot {
	const root = makeRoot(`rt5b-${slug}`, cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	mkdirSync(root.agentDir, { recursive: true });
	setConfig(root, { fx: stdioServer(["--tools", "1"]) });
	return root;
}

async function runtimeWithoutSessionStart(slug: string): Promise<Harness> {
	rootWithServer(slug);
	const harness = await createHarness({ extensionFactories: [mcpExtension as ExtensionFactory] });
	harnesses.push(harness);
	return harness;
}

function toolCall(runner: ExtensionRunner, id: string) {
	return runner.emitToolCall({ type: "tool_call", toolName: "read", input: { path: "a.txt" }, toolCallId: id });
}

function presenter(confirmed: boolean): ExtensionUIContext {
	return { ...noOpUIContext, confirm: async () => confirmed };
}

describe("MCP attaches without a session (RT5b)", () => {
	it("connects the configured servers at the first tool call and registers their tools", async () => {
		// Given a runtime that loaded the MCP builtin and never emitted session_start.
		const harness = await runtimeWithoutSessionStart("attach");
		// When its first tool call arrives.
		await toolCall(harness.getExtensionRunner(), "call-1");
		await getMcpService().whenAttachSettled();
		// Then the server's tool is registered.
		expect(harness.session.getAllTools().map(({ name }) => name)).toContain("mcp_fx_tool_1");
	});

	it("points elicitation at the runtime's UI broker", async () => {
		// Given a runtime whose UI is a broker with an attached presenter.
		const harness = await runtimeWithoutSessionStart("elicitation");
		const runner = harness.getExtensionRunner();
		const broker = new RuntimeUiBroker();
		runner.setUiBroker(broker);
		broker.attach(presenter(true));
		// When the first tool call attaches MCP.
		await toolCall(runner, "call-1");
		// Then an elicitation reaches the presenter.
		expect(await getMcpService().getMcpElicitationUi()?.confirm("Allow?", "")).toBe(true);
	});

	it("leaves elicitation unbound while the broker has no presenter", async () => {
		const harness = await runtimeWithoutSessionStart("no-presenter");
		const runner = harness.getExtensionRunner();
		runner.setUiBroker(new RuntimeUiBroker());
		await toolCall(runner, "call-1");
		expect(getMcpService().getMcpElicitationUi()).toBeUndefined();
	});

	it("does not attach again at a tool call once session_start attached the context", async () => {
		// Given a session whose session_start attached MCP.
		const harness = await runtimeWithoutSessionStart("session");
		const runner = harness.getExtensionRunner();
		await runner.emit({ type: "session_start", reason: "startup" });
		const attachSession = vi.spyOn(getMcpService(), "attachSession");
		// When tool calls arrive.
		await toolCall(runner, "call-1");
		await toolCall(runner, "call-2");
		// Then the first-use attach never runs on the session path.
		expect(attachSession).not.toHaveBeenCalled();
	});

	it("attaches once for a runtime whose contexts have no session manager", async () => {
		// Given a runner without a session manager over the loaded extensions.
		rootWithServer("runtime-key");
		const extensionsResult = await createTestExtensionsResult([
			{ path: "<builtin:mcp>", factory: mcpExtension as ExtensionFactory },
		]);
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		harnesses.push(harness);
		const runtime = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			process.cwd(),
			undefined,
			harness.session.modelRegistry,
			extensionsResult.eventBus,
		);
		const attachSession = vi.spyOn(getMcpService(), "attachSession");
		const added = vi.spyOn(WeakSet.prototype, "add");
		// When tool calls arrive.
		await toolCall(runtime, "call-1");
		await toolCall(runtime, "call-2");
		// Then the runtime attached once, and no undefined key reached a WeakSet.
		expect(attachSession).toHaveBeenCalledTimes(1);
		expect(added.mock.calls.some(([value]) => value === undefined)).toBe(false);
	});
});
