import { mkdirSync } from "node:fs";
import { fauxAssistantMessage, getCurrentSystemPrompt, getInitialSystemMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import mcpExtension from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import type { BuildSystemPromptOptions, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const LATER_BLOCK = "<later-extension-block>volatile</later-extension-block>";

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];

beforeEach(() => {
	resetMcpServiceForTests();
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

/** An extension loaded after the MCP builtin that appends its own block, like a memory extension. */
const laterExtension: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${LATER_BLOCK}` }), {
		previewSafe: true,
	});
};

const RUN_LAST_BLOCK = "<third-party-run-last>also wants to close the prompt</third-party-run-last>";

const thirdPartyRunLastExtension: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${RUN_LAST_BLOCK}` }), {
		previewSafe: true,
		runLast: true,
	});
};

const LATER_STABLE_BLOCK = "<later-stable-block>same in every session</later-stable-block>";

/** Loads after the MCP builtin and declares its block stable, like a harness-rules extension. */
const laterStableExtension: ExtensionFactory = (pi) => {
	pi.on(
		"before_agent_start",
		(event) => ({ systemPrompt: `${event.systemPrompt}\n\n${LATER_STABLE_BLOCK}`, systemPromptCache: "stable" }),
		{ previewSafe: true },
	);
};

describe("MCP instructions are last and outside the cached stable prefix (senpi#4448 + senpi#4447)", () => {
	it("ends the stable prefix right before <mcp_instructions>, after a stable block from a later extension", async () => {
		// Given: the MCP builtin and a later-loading extension whose addition is stable.
		const harness = await startHarness([laterStableExtension]);

		// When: a turn goes out, and the host composes a preview.
		let turn = { prompt: "", stablePrefix: undefined as string | undefined };
		harness.setResponses([
			(context) => {
				turn = {
					prompt: getCurrentSystemPrompt(context.messages),
					stablePrefix: getInitialSystemMessage(context.messages)?.stablePrefix,
				};
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("capture prompt");
		const preview = await harness
			.getExtensionRunner()
			.emitBeforeAgentStart("", undefined, "BASE", { cwd: process.cwd() } as BuildSystemPromptOptions, {
				preview: true,
			});

		// Then: in both, the stable prefix holds the later block and the volatile tail is exactly the MCP instructions.
		for (const { prompt, stablePrefix } of [
			turn,
			{ prompt: preview?.systemPrompt ?? "", stablePrefix: preview?.systemPromptStablePrefix },
		]) {
			expect(stablePrefix?.endsWith(LATER_STABLE_BLOCK)).toBe(true);
			expect(prompt.slice(0, stablePrefix?.length)).toBe(stablePrefix);
			const tail = prompt.slice(stablePrefix?.length ?? 0);
			expect(tail.trimStart().startsWith('<mcp_instructions server="fx">')).toBe(true);
			expect(tail.endsWith("</mcp_instructions>")).toBe(true);
		}
	});
});

describe("MCP instructions are the last system-prompt block (senpi#4448)", () => {
	it("keeps <mcp_instructions> last when a third-party extension also registers runLast, on a real turn and a preview", async () => {
		// Given: the MCP builtin, a plain later extension, and a later extension that also asks to run last.
		const harness = await startHarness([laterExtension, thirdPartyRunLastExtension]);

		// When: a turn goes out, and the host composes a preview.
		let turnPrompt = "";
		harness.setResponses([
			(context) => {
				turnPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("capture prompt");
		const preview = await harness
			.getExtensionRunner()
			.emitBeforeAgentStart("", undefined, "BASE", { cwd: process.cwd() } as BuildSystemPromptOptions, {
				preview: true,
			});

		// Then: the third-party run-last block follows the plain one, and the MCP instructions still close both prompts.
		for (const systemPrompt of [turnPrompt, preview?.systemPrompt ?? ""]) {
			const mcpAt = systemPrompt.indexOf('<mcp_instructions server="fx">');
			expect(systemPrompt.indexOf(LATER_BLOCK)).toBeLessThan(systemPrompt.indexOf(RUN_LAST_BLOCK));
			expect(systemPrompt.indexOf(RUN_LAST_BLOCK)).toBeGreaterThan(-1);
			expect(systemPrompt.indexOf(RUN_LAST_BLOCK)).toBeLessThan(mcpAt);
			expect(systemPrompt.endsWith("</mcp_instructions>")).toBe(true);
		}
	});

	it("puts <mcp_instructions> after an addition from an extension that loads later, on a real turn", async () => {
		// Given: an MCP server with instructions, and an extension after the MCP builtin that appends a block.
		const harness = await startHarness();

		// When: a turn goes out after the attach settled.
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				systemPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("capture prompt");

		// Then: the later extension's block comes first and the MCP instructions close the prompt.
		expect(systemPrompt.indexOf(LATER_BLOCK)).toBeGreaterThan(-1);
		expect(systemPrompt.indexOf(LATER_BLOCK)).toBeLessThan(systemPrompt.indexOf('<mcp_instructions server="fx">'));
		expect(systemPrompt.endsWith("</mcp_instructions>")).toBe(true);
	});

	it("uses the same order in a preview composition (prompt-cache prewarm)", async () => {
		// Given: the same extensions.
		const harness = await startHarness();

		// When: the host composes a preview.
		const result = await harness
			.getExtensionRunner()
			.emitBeforeAgentStart("", undefined, "BASE", { cwd: process.cwd() } as BuildSystemPromptOptions, {
				preview: true,
			});

		// Then: MCP instructions are the tail there too.
		const systemPrompt = result?.systemPrompt ?? "";
		expect(systemPrompt.startsWith(`BASE\n\n${LATER_BLOCK}`)).toBe(true);
		expect(systemPrompt.endsWith("</mcp_instructions>")).toBe(true);
	});
});

async function startHarness(laterExtensions: readonly ExtensionFactory[] = [laterExtension]): Promise<Harness> {
	const root = makeRoot("mcp-instructions-last", cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	mkdirSync(root.agentDir, { recursive: true });
	setConfig(root, {
		fx: {
			...stdioServer(["--tools", "1", "--instructions", "server instructions"]),
			connectTimeoutMs: 10_000,
		},
	});
	const harness = await createHarness({
		extensionFactories: [{ path: "<builtin:mcp>", factory: mcpExtension as ExtensionFactory }, ...laterExtensions],
	});
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	// Observe the exact deferred-connect completion, including a cold SDK import.
	// A timeout is not readiness: composing then would test a still-connecting server.
	expect(await getMcpService().whenAttachSettled(20_000)).toBe("settled");
	// One settled turn publishes the server's instructions to the service for the turns after it.
	harness.setResponses([fauxAssistantMessage("warm")]);
	await harness.session.prompt("warm");
	return harness;
}

function restoreEnv(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}
