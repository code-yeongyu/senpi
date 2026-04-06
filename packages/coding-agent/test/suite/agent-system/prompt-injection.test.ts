import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TYPE_ENV_VAR } from "../../../src/core/extensions/builtin/background-task/types.js";
import type { BeforeAgentStartEvent, ExtensionContext } from "../../../src/core/extensions/types.js";
import { createHarness, type Harness } from "../harness.js";

const AGENT_SYSTEM_EXTENSION_PATH = fileURLToPath(
	new URL("../../../src/core/extensions/builtin/agent-system/index.ts", import.meta.url),
);

async function loadAgentSystemExtension() {
	const module = await import(AGENT_SYSTEM_EXTENSION_PATH);
	return module.default;
}

describe("agent-system prompt injection", () => {
	const harnesses: Harness[] = [];
	const originalAgentType = process.env[AGENT_TYPE_ENV_VAR];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (originalAgentType === undefined) {
			delete process.env[AGENT_TYPE_ENV_VAR];
		} else {
			process.env[AGENT_TYPE_ENV_VAR] = originalAgentType;
		}
	});

	it("explore agent: system prompt includes file search specialist text", async () => {
		// given - set env var BEFORE importing extension
		process.env[AGENT_TYPE_ENV_VAR] = "explore";
		const agentSystemExtension = await loadAgentSystemExtension();
		let capturedSystemPrompt: string | undefined;

		const harness = await createHarness({
			extensionFactories: [
				agentSystemExtension,
				(pi) => {
					pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
						capturedSystemPrompt = event.systemPrompt;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		// Bind extensions to trigger session_start
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("test");

		// then
		expect(capturedSystemPrompt).toContain("file search specialist");
	});

	it("general agent: returns undefined (no custom prompt)", async () => {
		// given - set env var BEFORE importing extension
		process.env[AGENT_TYPE_ENV_VAR] = "general";
		const agentSystemExtension = await loadAgentSystemExtension();
		let handlerCalled = false;
		let returnedUndefined = false;

		const harness = await createHarness({
			extensionFactories: [
				agentSystemExtension,
				(pi) => {
					pi.on("before_agent_start", async (_event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
						handlerCalled = true;
						returnedUndefined = true;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		// Bind extensions to trigger session_start
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("test");

		// then
		expect(handlerCalled).toBe(true);
		expect(returnedUndefined).toBe(true);
	});

	it("custom agent with prompt: appends prompt to existing system prompt", async () => {
		// given - set env var BEFORE importing extension
		process.env[AGENT_TYPE_ENV_VAR] = "explore";
		const agentSystemExtension = await loadAgentSystemExtension();
		const customPrompt = "Custom agent instructions here";
		let originalPrompt: string | undefined;
		let modifiedPrompt: string | undefined;

		const harness = await createHarness({
			extensionFactories: [
				agentSystemExtension,
				(pi) => {
					pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
						originalPrompt = event.systemPrompt;
						modifiedPrompt = `${event.systemPrompt}\n\n${customPrompt}`;
						return { systemPrompt: modifiedPrompt };
					});
				},
			],
		});
		harnesses.push(harness);

		// Bind extensions to trigger session_start
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("test");

		// then
		expect(originalPrompt).toBeDefined();
		expect(modifiedPrompt).toBeDefined();
		expect(modifiedPrompt).toBe(`${originalPrompt}\n\n${customPrompt}`);
		expect(modifiedPrompt).toContain(customPrompt);
	});
});
