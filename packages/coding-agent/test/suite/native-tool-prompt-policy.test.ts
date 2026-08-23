import { afterEach, describe, expect, it } from "vitest";
import anthropicBashExtension from "../../src/core/extensions/builtin/anthropic-bash/index.ts";
import anthropicWebSearchExtension from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import bashTimeoutExtension from "../../src/core/extensions/builtin/bash-timeout/index.ts";
import imageGenExtension from "../../src/core/extensions/builtin/imagegen/index.ts";
import openaiWebSearchExtension from "../../src/core/extensions/builtin/openai-web-search/index.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

const ENV_KEYS = ["PI_ANTHROPIC_BASH", "PI_ANTHROPIC_WEB_SEARCH", "PI_OPENAI_WEB_SEARCH"] as const;

type BeforeAgentStartHandler = (
	event: { systemPrompt: string },
	ctx: ExtensionContext,
) => Promise<{ systemPrompt: string } | undefined>;

function captureBeforeAgentStart(factory: (pi: ExtensionAPI) => void): BeforeAgentStartHandler {
	let captured: BeforeAgentStartHandler | undefined;
	const api = new Proxy(
		{
			on(eventName: string, handler: unknown) {
				if (eventName === "before_agent_start") {
					captured = handler as BeforeAgentStartHandler;
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
	if (!captured) throw new Error("missing before_agent_start handler");
	return captured;
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
});
