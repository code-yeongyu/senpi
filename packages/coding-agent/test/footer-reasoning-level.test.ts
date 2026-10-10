import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

const WIDE = 160;
const NARROW = 70;

function renderPlain(width: number, options: Parameters<typeof createFooterSession>[0], providerCount = 1): string {
	const footer = new FooterComponent(createFooterSession(options), createFooterData(providerCount));
	const lines = footer.render(width);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return stripAnsi(lines[0] ?? "");
}

describe("footer reasoning level and cycle key (senpi#3090)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	afterAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("shows the level as a label with the default cycle key on a wide terminal", () => {
		setKeybindings(new KeybindingsManager());
		const plain = renderPlain(WIDE, {
			sessionName: "",
			modelId: "claude-opus-5-5",
			reasoning: true,
			thinkingLevel: "high",
		});
		expect(plain).toContain("claude-opus-5-5 • effort high (shift+tab)");
		expect(plain).not.toContain("claude-opus-5-5:high");
	});

	it("shows the user's rebound key, not the default", () => {
		setKeybindings(new KeybindingsManager({ "app.thinking.cycle": "ctrl+r" }));
		const plain = renderPlain(WIDE, {
			sessionName: "",
			modelId: "claude-opus-5-5",
			reasoning: true,
			thinkingLevel: "medium",
		});
		expect(plain).toContain("effort medium (ctrl+r)");
		expect(plain).not.toContain("shift+tab");
	});

	it("shows the level without a key hint when the cycle action is unbound", () => {
		setKeybindings(new KeybindingsManager({ "app.thinking.cycle": [] }));
		const plain = renderPlain(WIDE, {
			sessionName: "",
			modelId: "claude-opus-5-5",
			reasoning: true,
			thinkingLevel: "high",
		});
		expect(plain).toMatch(/claude-opus-5-5 • effort high$/);
		expect(plain).not.toContain("shift+tab");
	});

	it("shows `effort off` with the key for a reasoning model at level off", () => {
		setKeybindings(new KeybindingsManager());
		const plain = renderPlain(WIDE, { sessionName: "", modelId: "gpt-5.6", reasoning: true, thinkingLevel: "off" });
		expect(plain).toContain("gpt-5.6 • effort off (shift+tab)");
	});

	it("shows nothing new for a model without reasoning", () => {
		setKeybindings(new KeybindingsManager());
		const plain = renderPlain(WIDE, {
			sessionName: "",
			modelId: "plain-model",
			reasoning: false,
			thinkingLevel: "high",
		});
		expect(plain).toMatch(/plain-model$/);
		expect(plain).not.toContain("effort");
		expect(plain).not.toContain("shift+tab");
	});

	it("drops the key hint, then the provider, then the level, and keeps the model id as the width shrinks", () => {
		setKeybindings(new KeybindingsManager());
		const options = {
			sessionName: "deep-work-on-footer-layout",
			modelId: "claude-opus-5-5",
			reasoning: true,
			thinkingLevel: "high",
			cwd: "/workspace/client/platform/services/senpi/packages/coding-agent",
			usage: { input: 12_345, output: 6_789, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		};
		const wide = renderPlain(WIDE, options, 2);
		expect(wide).toContain("(test) claude-opus-5-5 • effort high (shift+tab)");

		const medium = renderPlain(80, options, 2);
		expect(medium).toContain("(test) claude-opus-5-5 • effort high");
		expect(medium).not.toContain("shift+tab");

		const narrow = renderPlain(NARROW, options, 2);
		expect(narrow).toContain("claude-opus-5-5 • effort high");
		expect(narrow).not.toContain("(test)");
		expect(narrow).not.toContain("shift+tab");

		const tight = renderPlain(40, options, 2);
		expect(tight).toContain("claude-opus-5-5");
		expect(tight).not.toContain("effort");
	});

	it("keeps the routed physical model beside the level label", () => {
		setKeybindings(new KeybindingsManager());
		const session = createFooterSession({ sessionName: "", modelId: "auto", reasoning: true, thinkingLevel: "high" });
		Object.assign(session, { routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" } });
		const plain = stripAnsi(new FooterComponent(session, createFooterData(1)).render(WIDE)[0] ?? "");
		expect(plain).toContain("auto → gpt-5.6-luna:medium • effort high (shift+tab)");
	});
});
