// Regression: senpi#4597. Upstream's rule: an extension that handles `mcp_servers_change` is the
// one that connects extension-registered MCP servers. senpi's built-in MCP gateway must then leave
// those servers alone (one connection per server), while still connecting its own `mcp.json`
// servers, and must keep connecting registered servers when no extension handles the event.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import mcpExtension from "../../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../../src/core/extensions/builtin/mcp/service.ts";
import type { McpServerSnapshot } from "../../../src/core/extensions/builtin/mcp/service-types.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { cleanupRoots, makeRoot, setConfig, type TestRoot } from "../../mcp/fixtures/service-lifecycle.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const open = new Set<Harness>();
const originalAgentDir = process.env[ENV_AGENT_DIR];
let root: TestRoot;

const registrar: ExtensionFactory = (pi) => {
	pi.registerMcpServer("registered", { type: "stdio", command: "never-spawned", enabled: false });
};

const claimant: ExtensionFactory = (pi) => {
	pi.on("mcp_servers_change", () => {});
};

beforeEach(() => {
	resetMcpServiceForTests();
	root = makeRoot("4597-ownership", cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	setConfig(root, { configured: { type: "stdio", command: "never-spawned", enabled: false } });
});

afterEach(async () => {
	for (const harness of open) harness.cleanup();
	open.clear();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	await cleanupRoots(cleanupTasks);
});

async function startSession(...extensions: ExtensionFactory[]): Promise<McpServerSnapshot[]> {
	const harness = await createHarness({
		cwd: root.cwd,
		extensionFactories: [{ path: "<builtin:mcp>", factory: mcpExtension }, ...extensions],
	});
	open.add(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return getMcpService().getServerSnapshots();
}

function named(snapshots: McpServerSnapshot[], name: string): McpServerSnapshot | undefined {
	return snapshots.find((snapshot) => snapshot.name === name);
}

describe("senpi#4597: built-in MCP gateway ownership handoff", () => {
	it("keeps connecting registered servers when no extension handles mcp_servers_change", async () => {
		const snapshots = await startSession(registrar);

		expect(named(snapshots, "registered")).toMatchObject({ source: "extension", configState: "disabled" });
		expect(named(snapshots, "configured")).toMatchObject({ source: "global", configState: "disabled" });
	});

	it("skips registered servers once an extension handles mcp_servers_change, and still loads mcp.json servers", async () => {
		const snapshots = await startSession(registrar, claimant);

		expect(named(snapshots, "registered")).toBeUndefined();
		expect(named(snapshots, "configured")).toMatchObject({ source: "global", configState: "disabled" });
	});
});
