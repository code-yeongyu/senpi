import { fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../../src/core/extensions/builtin/mcp/startup-race.ts";
import { cleanupRoots, fakePi, makeRoot, setConfig } from "../../mcp/fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "../../mcp/fixtures/sharing-http.ts";
import { createHarness } from "../harness.ts";

it("delivers the first provider request and response while a cold MCP catalog is held", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const root = makeRoot("2843-first-request", cleanup);
	const fixture = await sharingHttpFixture();
	const service = new McpService();
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];
	const listEntered = fixture.holdLists();
	const firstRequest = Promise.withResolvers<readonly string[]>();
	process.env[ENV_AGENT_DIR] = root.agentDir;
	process.env[MCP_STARTUP_TIMEOUT_ENV] = "5000";
	setConfig(root, {
		fx: { type: "http", url: fixture.url, auth: false, lifecycle: "eager", startupTimeoutMs: 5000 },
	});
	let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
	let prompt: Promise<unknown> | undefined;
	try {
		harness = await createHarness({ extensionFactories: [createMcpExtension(service)] });
		harness.setResponses([
			(context) => {
				firstRequest.resolve(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("fixture response");
			},
		]);
		await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
		prompt = harness.session.prompt("first request").catch((error: unknown) => error);
		await observed(listEntered, "MCP catalog request did not reach the fixture");
		const tools = await observed(firstRequest.promise, "First provider request is blocked by MCP catalog readiness");
		expect(tools).not.toContain("mcp_fx_echo");
		expect(await observed(prompt, "First response is blocked by MCP catalog readiness")).toBeUndefined();
		expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(true);
	} finally {
		fixture.releaseLists();
		await prompt;
		await service.dispose("quit");
		harness?.cleanup();
		await fixture.close();
		restoreEnv(ENV_AGENT_DIR, originalAgentDir);
		restoreEnv(MCP_STARTUP_TIMEOUT_ENV, originalStartupTimeout);
		await cleanupRoots(cleanup);
	}
});

it("publishes a connecting RPC inventory without waiting for the first remote catalog", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const root = makeRoot("2843-rpc-inventory", cleanup);
	const fixture = await sharingHttpFixture();
	const service = new McpService();
	const listEntered = fixture.holdLists();
	setConfig(root, {
		fx: { type: "http", url: fixture.url, auth: false, lifecycle: "eager", startupTimeoutMs: 5000 },
	});
	const attach = service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true, mode: "rpc" },
		fakePi(),
		{ agentDir: root.agentDir },
	);
	try {
		await observed(listEntered, "MCP catalog request did not reach the fixture");
		await observed(attach, "RPC session admission is blocked by MCP catalog readiness");
		const server = service.getWireStatusSnapshot().servers.find((server) => server.name === "fx");
		expect(server?.status).toBe("connecting");
		expect(server?.tools).toEqual([]);
	} finally {
		fixture.releaseLists();
		await attach;
		await service.dispose("quit");
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});

async function observed<T>(event: Promise<T>, failure: string): Promise<T> {
	const signal = AbortSignal.timeout(2000);
	let onTimeout: (() => void) | undefined;
	try {
		return await Promise.race([
			event,
			new Promise<never>((_resolve, reject) => {
				onTimeout = () => reject(new Error(failure));
				signal.addEventListener("abort", onTimeout, { once: true });
			}),
		]);
	} finally {
		if (onTimeout !== undefined) signal.removeEventListener("abort", onTimeout);
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
