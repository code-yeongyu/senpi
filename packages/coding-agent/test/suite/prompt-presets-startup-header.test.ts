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

function createHeaderContext(modelId: string): { context: HeaderContext; getHeaderText(): string } {
	let headerFactory: ((tui: never, theme: never) => Component) | undefined;
	return {
		context: {
			model: { id: modelId, provider: "openai-codex", api: "openai-codex-responses" },
			cwd: "/repo",
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

	it("refreshes header text on model_select", async () => {
		// given
		const { api, handlers } = makeApiMock();
		const { context, getHeaderText } = createHeaderContext("gpt-5.5");
		promptPresetExtension(api as never);
		await handlers.session_start[0]({ type: "session_start", reason: "startup" }, context);

		// when
		await handlers.model_select[0](
			{
				type: "model_select",
				model: { id: "claude-opus-4-7", provider: "anthropic", api: "anthropic-messages" },
				previousModel: context.model,
				source: "set",
			},
			context,
		);

		// then
		expect(getHeaderText()).toContain("Optimized system prompt applied: claude-opus-4-7");
	});

	it("clears the header when no preset matches the active model", async () => {
		// given
		const { api, handlers } = makeApiMock();
		const { context, getHeaderText } = createHeaderContext("gpt-5.5");
		promptPresetExtension(api as never);
		await handlers.session_start[0]({ type: "session_start", reason: "startup" }, context);
		expect(getHeaderText()).toContain("Optimized system prompt applied: gpt-5.5");

		// when
		const result = (await handlers.model_select[0](
			{
				type: "model_select",
				model: { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" },
				previousModel: context.model,
				source: "set",
			},
			context,
		)) as { systemPromptName?: string };

		// then
		expect(getHeaderText()).toBe("");
		expect(result.systemPromptName).toBeUndefined();
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
});
