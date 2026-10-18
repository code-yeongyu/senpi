import { afterEach, describe, expect, it, vi } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("ask-user zero-question boundary", () => {
	it("returns a validation error without creating pending UI", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				{
					factory: (pi) => {
						api = pi;
						askUserExtension(pi);
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (!api) throw new Error("extension factory never ran");
		const runner = harness.getExtensionRunner();
		const question = vi.fn();
		const ctx: ExtensionContext = {
			...runner.createContext(),
			mode: "tui",
			hasUI: true,
			ui: { ...runner.createContext().ui, question },
		};
		const tool = runner.getAllRegisteredTools().find((entry) => entry.definition.name === "ask_user_question");
		if (!tool) throw new Error("missing ask-user tool");

		const result = await tool.definition.execute(
			"zero",
			{ questions: [], waitForAnswer: false },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "questions must contain 1 to 4 items" }]);
		expect(result.details).toEqual({ status: "unavailable" });
		expect(question).not.toHaveBeenCalled();
		expect(getPendingQuestions(ctx.sessionManager.getSessionId())).toEqual([]);
	});
});
