import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicBashExtension from "../../src/core/extensions/builtin/anthropic-bash/index.ts";
import anthropicWebSearchExtension from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import bashTimeoutExtension from "../../src/core/extensions/builtin/bash-timeout/index.ts";
import imageGenExtension from "../../src/core/extensions/builtin/imagegen/index.ts";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import type { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import openaiWebSearchExtension from "../../src/core/extensions/builtin/openai-web-search/index.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

const ENV_KEYS = ["PI_ANTHROPIC_BASH", "PI_ANTHROPIC_WEB_SEARCH", "PI_OPENAI_WEB_SEARCH"] as const;

type BeforeAgentStartHandler = (
	event: { systemPrompt: string },
	ctx: ExtensionContext,
) => Promise<{ systemPrompt: string } | undefined>;

function captureHandler<T>(factory: (pi: ExtensionAPI) => void, eventName: string): T {
	let captured: T | undefined;
	const api = new Proxy(
		{
			events: {
				emit() {},
				on() {
					return () => undefined;
				},
			},
			on(registeredEvent: string, handler: unknown) {
				if (registeredEvent === eventName) {
					captured = handler as T;
				}
			},
		},
		{
			get(target, property) {
				if (property in target) return target[property as keyof typeof target];
				return () => undefined;
			},
		},
	) as ExtensionAPI;
	factory(api);
	if (!captured) throw new Error(`missing ${eventName} handler`);
	return captured;
}

function captureBeforeAgentStart(factory: (pi: ExtensionAPI) => void): BeforeAgentStartHandler {
	return captureHandler(factory, "before_agent_start");
}

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
});

describe("native tool prompt policy", () => {
	const cases = [
		{
			name: "terminal",
			factory: registerTerminalExtension,
			model: {},
		},
		{
			name: "bash timeout",
			factory: bashTimeoutExtension,
			model: {},
		},
		{
			name: "todo tools",
			factory: todotoolsExtension,
			model: {},
		},
		{
			name: "image generation",
			factory: imageGenExtension,
			model: {},
		},
		{
			name: "Anthropic bash",
			env: "PI_ANTHROPIC_BASH",
			factory: anthropicBashExtension,
			model: { api: "anthropic-messages" },
		},
		{
			name: "Anthropic web search",
			env: "PI_ANTHROPIC_WEB_SEARCH",
			factory: anthropicWebSearchExtension,
			model: {
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
			},
		},
		{
			name: "OpenAI web search",
			env: "PI_OPENAI_WEB_SEARCH",
			factory: openaiWebSearchExtension,
			model: { api: "openai-responses" },
		},
	] as const;

	for (const testCase of cases) {
		it(`does not advertise ${testCase.name} when session tools are disabled`, async () => {
			// Given
			if ("env" in testCase) process.env[testCase.env] = "1";
			const handler = captureBeforeAgentStart(testCase.factory);
			const ctx = {
				model: testCase.model,
				isToolUseDisabled: () => true,
			} as unknown as ExtensionContext;

			// When
			const result = await handler({ systemPrompt: "system" }, ctx);

			// Then
			expect(result).toBeUndefined();
		});
	}

	it("does not discover the imagegen skill when session tools are disabled", async () => {
		// Given
		const handler = captureHandler<
			(event: object, ctx: ExtensionContext) => Promise<{ skillPaths: string[] } | undefined>
		>(imageGenExtension, "resources_discover");
		const ctx = { isToolUseDisabled: () => true } as unknown as ExtensionContext;

		// When
		const result = await handler({}, ctx);

		// Then
		expect(result).toBeUndefined();
	});

	it("does not attach or inject MCP instructions when session tools are disabled", async () => {
		// Given
		const attachSession = vi.fn(async () => undefined);
		const service = new Proxy(
			{ attachSession },
			{
				get(target, property) {
					if (property in target) return target[property as keyof typeof target];
					if (property === "onWireStatusChanged") return () => () => undefined;
					return () => undefined;
				},
			},
		) as unknown as McpService;
		const handler = captureHandler<
			(
				event: { systemPrompt: string; systemPromptOptions: { skills: never[] } },
				ctx: ExtensionContext,
			) => Promise<{ systemPrompt: string } | undefined>
		>(createMcpExtension(service), "before_agent_start");
		const ctx = { isToolUseDisabled: () => true } as unknown as ExtensionContext;

		// When
		const result = await handler({ systemPrompt: "system", systemPromptOptions: { skills: [] } }, ctx);

		// Then
		expect(result).toBeUndefined();
		expect(attachSession).not.toHaveBeenCalled();
	});
});
