import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

type FallbackErrorFixture = {
	isInitialized: true;
	footer: { invalidate: () => void };
	fallbackAppliedBeforeRetryStart: boolean;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	setExtensionStatus: (key: string, text: string | undefined) => void;
	chatContainer: Container;
	ui: { requestRender: () => void };
};

type InteractiveEventHandler = {
	handleEvent(this: FallbackErrorFixture, event: AgentSessionEvent): Promise<void>;
};

function stripSgr(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("InteractiveMode fallback exhaustion errors", () => {
	it("renders a provider-derived exhausted fallback error safely without mutating the raw event", async () => {
		initTheme("dark");
		const rawProviderError =
			"fallback failed \u001b]52;c;c2VjcmV0\u0007 with \u001b]0;owned title\u0007 " +
			"\u001b]8;;https://attacker.invalid\u0007hyperlink\u001b]8;;\u0007 \u001b[31mCSI\u001b[0m " +
			"\u0000\u0001\u007f\u0085\u009b31mC1\u009b0m";
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "primary classifier refusal",
					stopDetails: { type: "refusal" },
				}),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: rawProviderError,
					stopDetails: { type: "refusal" },
				}),
			]);
			await harness.session.prompt("exhaust fallback chain");
			const exhausted = harness.eventsOfType("retry_fallback_exhausted").at(-1);
			if (!exhausted) throw new Error("Expected retry_fallback_exhausted event");
			expect(exhausted.lastError).toBe(rawProviderError);
			expect(harness.session.messages.at(-1)).toMatchObject({ errorMessage: rawProviderError });

			const fixture: FallbackErrorFixture = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				fallbackAppliedBeforeRetryStart: false,
				showWarning: vi.fn(),
				showStatus: vi.fn(),
				showError(message) {
					InteractiveMode.prototype.showError.call(fixture, message);
				},
				setExtensionStatus: vi.fn(),
				chatContainer: new Container(),
				ui: { requestRender: vi.fn() },
			};
			const handleEvent = (InteractiveMode.prototype as unknown as InteractiveEventHandler).handleEvent;
			await handleEvent.call(fixture, exhausted);

			const rendered = stripSgr(fixture.chatContainer.children.flatMap((child) => child.render(320)).join(" "));
			expect(rendered).toContain(
				"Error: Fallback chain exhausted for faux/faux-1: fallback failed with hyperlink CSI C1",
			);
			expect(rendered).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
			expect(rendered).not.toContain("c2VjcmV0");
			expect(rendered).not.toContain("owned title");
			expect(rendered).not.toContain("attacker.invalid");
		} finally {
			harness.cleanup();
		}
	});
});
