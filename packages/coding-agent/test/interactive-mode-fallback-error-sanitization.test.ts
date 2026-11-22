import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { NoticeSpec } from "../src/core/extensions/notice/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { ProviderErrorPresentation } from "../src/modes/interactive/provider-error-presentation.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

type FallbackErrorFixture = {
	isInitialized: true;
	footer: { invalidate: () => void };
	fallbackAppliedBeforeRetryStart: boolean;
	toolOutputExpanded: boolean;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	showNoticeBox: (spec: NoticeSpec) => void;
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
	it("shows the provider-requested long wait when terminal retry ends without an attempt", async () => {
		initTheme("dark");
		const raw = "HTTP 429: rate_limit_error (retry-after-ms: 3600000)";
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		try {
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: raw })]);
			await harness.session.prompt("hit the long rate-limit wait");
			const ended = harness.eventsOfType("auto_retry_end").at(-1);
			if (!ended?.finalError) throw new Error("missing long-wait terminal event");
			expect(ended).toMatchObject({ success: false, attempt: 0 });
			expect(ended.finalError).toContain("3600s");
			const chat = new Container();
			const providerErrors = new ProviderErrorPresentation(chat);
			providerErrors.record(raw, true);
			const fixture = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				fallbackAppliedBeforeRetryStart: false,
				clearStatusIndicator: vi.fn(),
				providerErrors,
				getProviderErrors: () => providerErrors,
				showError: vi.fn(),
				ui: { requestRender: vi.fn() },
			};
			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
			await Reflect.apply(handleEvent, fixture, [ended]);
			const rendered = stripSgr(chat.children.flatMap((child) => child.render(500)).join("\n"));
			expect(rendered).toContain(ended.finalError);
			expect(fixture.clearStatusIndicator).toHaveBeenCalledWith("retry");
		} finally {
			harness.cleanup();
		}
	});

	it("does not label a fail-fast account refusal as zero failed retry attempts", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true } } });
		try {
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: '429 {"error":{"message":"You have hit your session limit"}}',
				}),
			]);
			await harness.session.prompt("hit the account limit");
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
			expect(harness.eventsOfType("message_end").at(-1)).toMatchObject({
				message: { errorCause: { type: "usage_limit", scope: "account" } },
			});
		} finally {
			harness.cleanup();
		}
	});

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
				toolOutputExpanded: false,
				showWarning: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				showNoticeBox(spec) {
					InteractiveMode.prototype.showNoticeBox.call(fixture, spec);
				},
				setExtensionStatus: vi.fn(),
				chatContainer: new Container(),
				ui: { requestRender: vi.fn() },
			};
			const handleEvent = (InteractiveMode.prototype as unknown as InteractiveEventHandler).handleEvent;
			await handleEvent.call(fixture, exhausted);

			const rendered = stripSgr(fixture.chatContainer.children.flatMap((child) => child.render(320)).join(" "));
			expect(rendered).toContain("Fallback chain exhausted");
			expect(rendered).toContain("faux/faux-1");
			expect(rendered).toContain("fallback failed with hyperlink CSI C1");
			expect(rendered).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
			expect(rendered).not.toContain("c2VjcmV0");
			expect(rendered).not.toContain("owned title");
			expect(rendered).not.toContain("attacker.invalid");
		} finally {
			harness.cleanup();
		}
	});
});
