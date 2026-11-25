import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";

type Handler = (event: unknown, context: HeaderContext) => Promise<unknown> | unknown;

interface ApiMock {
	api: { on(event: string, handler: Handler): void };
	handlers: Record<string, Handler[]>;
}

interface HeaderContext {
	model: { id: string; provider: string; api: string };
	cwd: string;
	getSystemPromptOptions(): { cwd: string; customPrompt?: string };
	ui: {
		setHeader(factory: ((tui: never, theme: never) => Component & { dispose?(): void }) | undefined): void;
	};
}

function makeApiMock(): ApiMock {
	const handlers: Record<string, Handler[]> = {};
	return {
		api: {
			on(event: string, handler: Handler) {
				const list = handlers[event] ?? [];
				list.push(handler);
				handlers[event] = list;
			},
		},
		handlers,
	};
}

function renderHeaderText(factory: ((tui: never, theme: never) => Component) | undefined): string {
	if (!factory) {
		return "";
	}
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
	};
	return factory({} as never, theme as never)
		.render(120)
		.join("\n");
}

function createHeaderContext(
	modelId: string,
	options?: { customPrompt?: string },
): { context: HeaderContext; getHeaderText(): string } {
	let headerFactory: ((tui: never, theme: never) => Component) | undefined;
	return {
		context: {
			model: { id: modelId, provider: "chatgpt-subscription", api: "openai-codex-responses" },
			cwd: "/repo",
			getSystemPromptOptions: () => ({ cwd: "/repo", customPrompt: options?.customPrompt }),
			ui: {
				setHeader(factory) {
					headerFactory = factory;
				},
			},
		},
		getHeaderText() {
			return renderHeaderText(headerFactory);
		},
	};
}

describe("prompt preset startup header", () => {
	it("sets startup header during session_start instead of extension factory", async () => {
		// given
		const { api, handlers } = makeApiMock();
		const { context, getHeaderText } = createHeaderContext("gpt-5.5");

		// when
		promptPresetExtension(api as never);

		// then
		expect(getHeaderText()).toBe("");

		// when
		await handlers.session_start[0]({ type: "session_start", reason: "startup" }, context);

		// then
		expect(getHeaderText()).toContain("Optimized system prompt applied: gpt-5.5");
	});

	// sisyphuslabs/doriterm#2745: the header is the transcript's first row, far above the screen once the
	// session has history. Rewriting it on a model switch made the renderer clear the scrollback and replay
	// the whole transcript, so a switch leaves it alone; the switch result still names the new preset.
	it.each([
		{ modelId: "claude-opus-4-7", systemPromptName: "claude-opus-4-7" },
		{ modelId: "claude-sonnet-4-5", systemPromptName: undefined },
	])("keeps the startup header when model_select switches to $modelId", async ({ modelId, systemPromptName }) => {
		// given
		const { api, handlers } = makeApiMock();
		const { context, getHeaderText } = createHeaderContext("gpt-5.5");
		promptPresetExtension(api as never);
		await handlers.session_start[0]({ type: "session_start", reason: "startup" }, context);
		const startupHeader = getHeaderText();

		// when
		const result = (await handlers.model_select[0](
			{
				type: "model_select",
				model: { id: modelId, provider: "anthropic", api: "anthropic-messages" },
				previousModel: context.model,
				source: "set",
			},
			context,
		)) as { systemPromptName?: string };

		// then
		expect(getHeaderText()).toBe(startupHeader);
		expect(result.systemPromptName).toBe(systemPromptName);
	});

	it("shows no startup header for a model without a matching preset", async () => {
		// given
		const { api, handlers } = makeApiMock();
		const { context, getHeaderText } = createHeaderContext("claude-sonnet-4-5");
		promptPresetExtension(api as never);

		// when
		await handlers.session_start[0]({ type: "session_start", reason: "startup" }, context);

		// then
		expect(getHeaderText()).toBe("");
	});

	it("shows no startup header when the user provided a custom system prompt", async () => {
		// given
		const { api, handlers } = makeApiMock();
		const { context, getHeaderText } = createHeaderContext("gpt-5.5", { customPrompt: "Custom base prompt." });
		promptPresetExtension(api as never);

		// when
		await handlers.session_start[0]({ type: "session_start", reason: "startup" }, context);

		// then
		expect(getHeaderText()).toBe("");
	});
});
