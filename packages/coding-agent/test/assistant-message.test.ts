import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "errorMessage" | "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders providerNative content with collapsed and expanded states", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "providerNative",
					subtype: "web_search",
					raw: {
						items: Array.from({ length: 60 }, (_, index) => ({
							id: index,
							title: `Result ${index}`,
						})),
					},
				},
			]),
		);

		const collapsed = component.render(120).join("\n");
		expect(collapsed).toContain("▸ openai · providerNative · web_search");
		expect(collapsed).toContain("…");

		component.setExpanded(true);
		const expanded = component.render(120).join("\n");
		expect(expanded).toContain("▾ openai · providerNative · web_search");
		expect(expanded).toContain('"title": "Result 59"');
	});

	test("renders resumed assistant error messages with no text content", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "" }], {
				stopReason: "error",
				errorMessage: "network disconnected",
			}),
		);

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Error: network disconnected");
	});

	test("renders resumed aborted assistant messages with a stable user-facing label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([], {
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			}),
		);

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Operation aborted");
	});

	test("renders Anthropic server web search calls as compact providerNative summaries", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent({
			...createAssistantMessage([
				{
					type: "providerNative",
					subtype: "server_tool_use",
					raw: {
						type: "server_tool_use",
						id: "srvtoolu_123",
						name: "web_search",
						input: { query: "latest ast-grep release" },
					},
				},
			]),
			api: "anthropic-messages",
			provider: "anthropic",
		});

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("▸ anthropic · web_search · server_tool_use");
		expect(rendered).toContain('query: "latest ast-grep release"');
		expect(rendered).not.toContain('"type": "server_tool_use"');
	});

	test("renders Anthropic web search results without dumping encrypted payloads", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent({
			...createAssistantMessage([
				{
					type: "providerNative",
					subtype: "web_search_tool_result",
					raw: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_123",
						content: [
							{
								type: "web_search_result",
								title: "ast-grep documentation",
								url: "https://ast-grep.github.io/",
								encrypted_content: "secret-payload",
							},
							{
								type: "web_search_result",
								title: "ast-grep releases",
								url: "https://github.com/ast-grep/ast-grep/releases",
							},
						],
					},
				},
			]),
			api: "anthropic-messages",
			provider: "anthropic",
		});

		const rendered = component.render(160).join("\n");
		expect(rendered).toContain("▸ anthropic · web_search results");
		expect(rendered).toContain("2 results");
		expect(rendered).toContain("ast-grep documentation");
		expect(rendered).toContain("https://ast-grep.github.io/");
		expect(rendered).not.toContain("secret-payload");
		expect(rendered).not.toContain("encrypted_content");
	});

	test("#given OpenAI native web_search_call sources #when rendering providerNative #then displays status query and sources", () => {
		// given
		initTheme("dark");

		const component = new AssistantMessageComponent({
			...createAssistantMessage([
				{
					type: "providerNative",
					subtype: "web_search_call",
					raw: {
						type: "web_search_call",
						id: "ws_123",
						status: "completed",
						action: {
							type: "search",
							queries: ["native search tui"],
							sources: [
								{
									title: "OpenAI web search docs",
									url: "https://platform.openai.com/docs/guides/tools-web-search",
									snippet: "Use web search to retrieve current information.",
								},
							],
						},
					},
				},
			]),
			api: "openai-responses",
			provider: "openai",
		});

		// when
		const rendered = component.render(180).join("\n");

		// then
		expect(rendered).toContain("▸ openai · web_search · completed");
		expect(rendered).toContain("status: completed");
		expect(rendered).toContain('query: "native search tui"');
		expect(rendered).toContain("1 source");
		expect(rendered).toContain("OpenAI web search docs");
		expect(rendered).toContain("https://platform.openai.com/docs/guides/tools-web-search");
		expect(rendered).toContain("Use web search to retrieve current information.");
		expect(rendered).not.toContain('"type": "web_search_call"');
	});

	test("#given Google grounding metadata #when rendering providerNative #then displays queries and grounded sources", () => {
		// given
		initTheme("dark");

		const component = new AssistantMessageComponent({
			...createAssistantMessage([
				{
					type: "providerNative",
					subtype: "groundingMetadata",
					raw: {
						webSearchQueries: ["Gemini native search grounding"],
						groundingChunks: [
							{
								web: {
									title: "Gemini grounding docs",
									uri: "https://ai.google.dev/gemini-api/docs/grounding",
								},
							},
						],
					},
				},
			]),
			api: "google-generative-ai",
			provider: "google",
		});

		// when
		const rendered = component.render(180).join("\n");

		// then
		expect(rendered).toContain("▸ google · google_search results");
		expect(rendered).toContain('query: "Gemini native search grounding"');
		expect(rendered).toContain("1 source");
		expect(rendered).toContain("Gemini grounding docs");
		expect(rendered).toContain("https://ai.google.dev/gemini-api/docs/grounding");
		expect(rendered).not.toContain("groundingChunks");
	});

	test("renders length stops as visible errors", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("maximum output token limit");
		expect(rendered).toContain("response may be incomplete");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("renders a finished Thought duration header above the visible Markdown body", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "visible **Markdown** body", startedAt: 1_000, endedAt: 4_200 },
			]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));
		const headerIndex = rendered.indexOf("Thought: 3.2s");
		const bodyIndex = rendered.indexOf("visible Markdown body");

		expect(rendered.split("\n").some((line) => line.trim() === "Thought: 3.2s")).toBe(true);
		expect(headerIndex).toBeGreaterThanOrEqual(0);
		expect(bodyIndex).toBeGreaterThan(headerIndex);
	});

	test("renders a finished Thought duration in place of the hidden label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "hidden body", startedAt: 1_000, endedAt: 4_200 }]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.split("\n").some((line) => line.trim() === "Thought: 3.2s")).toBe(true);
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).not.toContain("hidden body");
	});

	test("uses the hidden label for an active Thought run", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "active body", startedAt: 1_000 },
				{ type: "thinking", thinking: "still active", startedAt: 1_100 },
			]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.split("\n").some((line) => line.trim() === "Thinking...")).toBe(true);
		expect(rendered).toContain("active body");
		expect(rendered).not.toContain("Thought:");
	});

	test("keeps legacy no Thought runs unchanged", () => {
		initTheme("dark");

		const message = createAssistantMessage([{ type: "thinking", thinking: "legacy body" }]);
		const visible = stripAnsi(new AssistantMessageComponent(message).render(80).join("\n"));
		const hidden = stripAnsi(new AssistantMessageComponent(message, true).render(80).join("\n"));

		expect(visible).toBe(`\n legacy body${" ".repeat(68)}`);
		expect(visible).not.toContain("Thought:");
		expect(hidden).toBe(`\n Thinking...${" ".repeat(68)}`);
		expect(hidden).not.toContain("Thought:");
	});

	test("spans empty timed blocks when computing a finished Thought duration", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "", startedAt: 1_000, endedAt: 1_500 },
				{ type: "thinking", thinking: "visible body", startedAt: 2_000, endedAt: 5_000 },
			]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.split("\n").some((line) => line.trim() === "Thought: 4.0s")).toBe(true);
		expect(rendered).toContain("visible body");
	});

	test("uses a custom label for active Thought runs but a duration for finished runs", () => {
		initTheme("dark");

		const active = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "active body", startedAt: 1_000 }]),
			false,
			undefined,
			"Custom thinking label",
		);
		const finished = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "finished body", startedAt: 1_000, endedAt: 4_200 }]),
			true,
			undefined,
			"Custom thinking label",
		);

		expect(stripAnsi(active.render(80).join("\n"))).toContain("Custom thinking label");
		expect(stripAnsi(finished.render(80).join("\n"))).toContain("Thought: 3.2s");
		expect(stripAnsi(finished.render(80).join("\n"))).not.toContain("Custom thinking label");
	});

	test("renders no Thought header or body for all-empty timed runs", () => {
		initTheme("dark");

		const message = createAssistantMessage([
			{ type: "thinking", thinking: "", startedAt: 1_000, endedAt: 4_200 },
			{ type: "thinking", thinking: "   ", startedAt: 1_100, endedAt: 4_000 },
		]);
		const visible = stripAnsi(new AssistantMessageComponent(message).render(80).join("\n"));
		const hidden = stripAnsi(new AssistantMessageComponent(message, true).render(80).join("\n"));

		expect(visible).not.toContain("Thought:");
		expect(visible.trim()).toBe("");
		expect(hidden).not.toContain("Thought:");
		expect(hidden.trim()).toBe("");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
