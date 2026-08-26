import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderAll(container: Container, width = 220): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.showHighReasoningWarning", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders a scary warning box naming the model+level and urging ultrabrain", () => {
		const fakeThis = {
			chatContainer: new Container(),
			toolOutputExpanded: false,
			ui: { requestRender: vi.fn() },
			showNoticeBox(spec: unknown): void {
				(InteractiveMode as any).prototype.showNoticeBox.call(fakeThis, spec);
			},
		};

		const event = {
			type: "high_reasoning_warning",
			modelId: "gpt-5.6-sol",
			provider: "openai",
			thinkingLevel: "xhigh",
		} as Extract<AgentSessionEvent, { type: "high_reasoning_warning" }>;

		(
			InteractiveMode as unknown as { prototype: { showHighReasoningWarning(this: unknown, event: unknown): void } }
		).prototype.showHighReasoningWarning.call(fakeThis, event);

		expect(fakeThis.chatContainer.children).toHaveLength(2);
		const rendered = stripAnsi(renderAll(fakeThis.chatContainer));
		expect(rendered).toMatch(/WARNING/i);
		expect(rendered).toContain("gpt-5.6-sol");
		expect(rendered).toContain("xhigh");
		expect(rendered).toMatch(/ultrabrain/i);
		expect(rendered).toMatch(/responsibilit/i);
		expect(rendered).toMatch(/stop|loop/i);
	});

	test("reflects the max level for a sol variant when max is selected", () => {
		const fakeThis = {
			chatContainer: new Container(),
			toolOutputExpanded: false,
			ui: { requestRender: vi.fn() },
			showNoticeBox(spec: unknown): void {
				(InteractiveMode as any).prototype.showNoticeBox.call(fakeThis, spec);
			},
		};
		const event = {
			type: "high_reasoning_warning",
			modelId: "openai/gpt-5.6-sol-pro",
			provider: "openai",
			thinkingLevel: "max",
		} as Extract<AgentSessionEvent, { type: "high_reasoning_warning" }>;

		(
			InteractiveMode as unknown as { prototype: { showHighReasoningWarning(this: unknown, event: unknown): void } }
		).prototype.showHighReasoningWarning.call(fakeThis, event);

		expect(stripAnsi(renderAll(fakeThis.chatContainer))).toContain("max");
		expect(stripAnsi(renderAll(fakeThis.chatContainer))).toContain("openai/gpt-5.6-sol-pro");
	});
});
