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

	it("drops the key hint, then the readable label, then the provider as the width shrinks; model:level stays", () => {
		setKeybindings(new KeybindingsManager());
		const options = {
			sessionName: "deep-work-on-footer-layout",
			modelId: "claude-opus-5-5",
			reasoning: true,
			thinkingLevel: "high",
			cwd: "/workspace/client/platform/services/senpi/packages/coding-agent",
			usage: { input: 12_345, output: 6_789, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		};
		const wide = renderPlain(200, options, 2);
		expect(wide).toContain("(test) claude-opus-5-5 • effort high (shift+tab)");

		const medium = renderPlain(100, options, 2);
		expect(medium).toContain("(test) claude-opus-5-5:high");
		expect(medium).not.toContain("shift+tab");
		expect(medium).not.toContain("effort");

		const narrow = renderPlain(NARROW, options, 2);
		expect(narrow).toContain("claude-opus-5-5:high");
		expect(narrow).not.toContain("effort");

		const tight = renderPlain(40, options, 2);
		expect(tight).toContain("claude-opus-5-5");
	});

	it("never lets the key hint evict a live stat: the hint shows only when every stat fits", () => {
		setKeybindings(new KeybindingsManager());
		const options = {
			sessionName: "deep-work",
			modelId: "claude-opus-5-5",
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		};
		let hintSeen = false;
		for (let width = 60; width <= 200; width++) {
			const plain = renderPlain(width, options, 2);
			if (!plain.includes("(shift+tab)")) continue;
			hintSeen = true;
			expect(plain, `width ${width}`).toContain("$1.234");
			expect(plain, `width ${width}`).toContain("CH25.0%");
			expect(plain, `width ${width}`).toContain("deep-work");
			expect(plain, `width ${width}`).not.toContain("…");
		}
		expect(hintSeen).toBe(true);
	});

	it("shows the cost stat from the same width main did (100 columns) with the level beside the model", () => {
		setKeybindings(new KeybindingsManager());
		const options = {
			sessionName: "",
			modelId: "claude-opus-5-5",
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		};
		for (const width of [100, 105, 110, 119]) {
			const plain = renderPlain(width, options, 2);
			expect(plain, `width ${width}`).toContain("$1.234");
			expect(plain, `width ${width}`).toContain("CH25.0%");
			expect(plain, `width ${width}`).toMatch(/\(test\) claude-opus-5-5(:high| • effort high)/);
		}
	});

	it("shortens the path before dropping the level at narrow widths", () => {
		setKeybindings(new KeybindingsManager());
		const options = {
			sessionName: "deep-work-on-footer-layout",
			modelId: "test-model",
			reasoning: true,
			thinkingLevel: "high",
			usage: { input: 12_345, output: 6_789, cacheRead: 50, cacheWrite: 50, cost: { total: 1.234 } },
		};
		for (const width of [45, 50, 55, 60, 65, 69]) {
			const plain = renderPlain(width, options, 2);
			expect(plain, `width ${width}`).toContain("test-model:high");
		}
		expect(renderPlain(60, options, 2)).toMatch(/^…/);
	});

	it("keeps the routed physical model beside the level label", () => {
		setKeybindings(new KeybindingsManager());
		const session = createFooterSession({ sessionName: "", modelId: "auto", reasoning: true, thinkingLevel: "high" });
		Object.assign(session, { routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" } });
		const plain = stripAnsi(new FooterComponent(session, createFooterData(1)).render(WIDE)[0] ?? "");
		expect(plain).toContain("auto → gpt-5.6-luna:medium • effort high (shift+tab)");
	});
});
