import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import mcpExtension from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

interface CapturedTurn {
	readonly systemPrompt: string;
	readonly connectionState: string | undefined;
	readonly toolNames: readonly string[];
}

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];

beforeEach(() => {
	resetMcpServiceForTests();
	// The held catalog, not scheduling or startup timing, controls publication.
	process.env[MCP_STARTUP_TIMEOUT_ENV] = "0";
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	restoreEnv(ENV_AGENT_DIR, originalAgentDir);
	restoreEnv(MCP_STARTUP_TIMEOUT_ENV, originalStartupTimeout);
	await cleanupRoots(cleanupTasks);
});

describe("MCP deferred attach vs. system prompt assembly", () => {
	it("publishes deferred instructions to the next turn without delaying the first", async () => {
		// Given: a server whose attach connect is deferred past session_start.
		const root = deferredAttachRoot("instructions");

		// When: the new session builds its first system prompt.
		const { first, second } = await startSessionAndCaptureTurns(root);

		// Then: that prompt carries the server's current instructions.
		expect(instructionsFor(first.systemPrompt, "fx")).toBeNull();
		expect(instructionsFor(second.systemPrompt, "fx")).toBe("deferred instructions");
	});

	it("publishes deferred tools to the next payload without inventing first-turn schemas", async () => {
		// Given: a server whose attach connect is deferred past session_start.
		const root = deferredAttachRoot("tools");

		// When: the new session sends its first turn.
		const { first, second } = await startSessionAndCaptureTurns(root);

		// Then: the payload already carries that server's tool catalog.
		expect(first.toolNames).not.toContain("mcp_fx_tool_1");
		expect(second.toolNames).toContain("mcp_fx_tool_1");
	});

	it("reports connecting while the first turn proceeds and connected after catalog publication", async () => {
		// Given: a server whose attach connect is deferred past session_start.
		const root = deferredAttachRoot("state");

		// When: the new session sends its first turn.
		const { first, second } = await startSessionAndCaptureTurns(root);

		// Then: the prompt build observed the attach instead of assuming it.
		expect(first.connectionState).toBe("connecting");
		expect(second.connectionState).toBe("connected");
	});
});

function deferredAttachRoot(slug: string): TestRoot {
	const root = makeRoot(`attach-prompt-${slug}`, cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	mkdirSync(root.agentDir, { recursive: true });
	setConfig(root, {
		fx: stdioServer([
			"--tools",
			"1",
			"--instructions",
			"deferred instructions",
			"--list-tools-gate",
			join(root.cwd, "catalog-ready"),
		]),
	});
	return root;
}

/**
 * Drive the production ordering: session_start dispatches the attach and
 * returns without waiting for it, then the first turn builds the system prompt.
 * The first prompt completes with the catalog held. The next prompt observes
 * explicitly settled publication, not a scheduling delay.
 */
async function startSessionAndCaptureTurns(root: TestRoot): Promise<{ first: CapturedTurn; second: CapturedTurn }> {
	process.env[ENV_AGENT_DIR] = root.agentDir;
	const harness = await createHarness({ extensionFactories: [mcpExtension as ExtensionFactory] });
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	let captured: CapturedTurn = { systemPrompt: "", connectionState: undefined, toolNames: [] };
	harness.setResponses([
		async (context) => {
			await getMcpService().refreshWireStatusSnapshot();
			captured = {
				systemPrompt: getCurrentSystemPrompt(context.messages),
				connectionState: getMcpService()
					.getWireStatusSnapshot()
					.servers.find((server) => server.name === "fx")?.status,
				toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
			};
			return fauxAssistantMessage("done");
		},
	]);
	const signal = AbortSignal.timeout(10_000);
	const prompt = harness.session.prompt("capture first prompt");
	try {
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(new Error("First prompt waited for catalog publication"));
			signal.addEventListener("abort", abort, { once: true });
			void prompt.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	} finally {
		writeFileSync(join(root.cwd, "catalog-ready"), "ready");
		await prompt;
	}
	const first = captured;
	await getMcpService().whenAttachSettled();
	await getMcpService().refreshWireStatusSnapshot();
	harness.setResponses([
		(context) => {
			captured = {
				systemPrompt: getCurrentSystemPrompt(context.messages),
				connectionState: getMcpService()
					.getWireStatusSnapshot()
					.servers.find((server) => server.name === "fx")?.status,
				toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
			};
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("capture next prompt");
	return { first, second: captured };
}

function instructionsFor(systemPrompt: string, server: string): string | null {
	const match = new RegExp(`<mcp_instructions server="${server}">\\n([\\s\\S]*?)\\n</mcp_instructions>`).exec(
		systemPrompt,
	);
	return match?.[1] ?? null;
}

function restoreEnv(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}
