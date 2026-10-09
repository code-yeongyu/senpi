import { afterEach, expect, it } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import { askUserRenderers, renderCall, renderResult } from "../../src/core/extensions/builtin/ask-user/render.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

// #1857: a card can stream while the registry has no ask-user tools, so its renderers must not
// depend on the registration. `interactive-mode.getRegisteredToolDefinition` joins the two halves
// pinned below: `session.getToolDefinition(name) ?? askUserRenderers(name)`.
it("serves question renderers for both tool names without a registration", () => {
	for (const name of ["ask_user_question", "request_user_input"]) {
		expect(askUserRenderers(name)).toEqual({ renderCall, renderResult });
	}
	expect(askUserRenderers("read")).toBeUndefined();
});

it("leaves both question tools inactive and unregistered until session_start synchronizes them", async () => {
	const harness = await createHarness({ extensionFactories: [{ factory: askUserExtension }] });
	harnesses.push(harness);
	for (const name of ["ask_user_question", "request_user_input"]) {
		expect(harness.session.getActiveToolNames()).not.toContain(name);
		expect(harness.session.getToolDefinition(name)).toBeUndefined();
	}
});

it("loses the tool definitions during a reload, which is the window the renderers cover", async () => {
	const delivery = await createAskUserDelivery();
	harnesses.push(delivery.harness);
	const context = delivery.context(() => new Promise(() => {}));
	await delivery.harness.session.bindExtensions({ uiContext: context.ui, mode: "tui" });
	expect(delivery.harness.session.getToolDefinition("ask_user_question")).toBeDefined();
	let checked = false;
	await delivery.harness.session.reload({
		beforeSessionStart: () => {
			checked = true;
			for (const name of ["ask_user_question", "request_user_input"]) {
				expect(delivery.harness.session.getToolDefinition(name)).toBeUndefined();
				expect(askUserRenderers(name)?.renderCall).toBe(renderCall);
			}
		},
	});
	expect(checked).toBe(true);
});
