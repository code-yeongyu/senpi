import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionCompactEvent } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../harness.ts";

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "assistant response to compact" }],
		model: harness.getModel().id,
		provider: harness.getModel().provider,
		api: harness.getModel().api,
		stopReason: "stop",
		usage: {
			input: 100,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: now - 500,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to keep" }],
		timestamp: now,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("Regression: manual /compact silent rejection", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits observable feedback when manual compaction would overflow the context window", async () => {
		const oversizedSummary = "S".repeat(4000);
		const compactSessionEvents: SessionCompactEvent[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 50 }],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: oversizedSummary,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "regression-oversized" },
						},
					}));
					pi.on("session_compact", async (event) => {
						compactSessionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow(/[Cc]ompaction (rejected|failed)/);

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toBeDefined();
		expect(compactionEnd?.accepted).toBe(false);
		expect(compactionEnd?.rejectionCause).toBe("would-overflow");
		expect(compactionEnd?.errorMessage).toBeDefined();
		expect(compactionEnd?.errorMessage ?? "").toMatch(/overflow|context window/i);

		const rejectionEvent = compactSessionEvents.find((event) => event.accepted === false);
		expect(rejectionEvent).toBeDefined();
		expect(rejectionEvent?.rejectionCause).toBe("would-overflow");
	});

	it("threads extension cancel reasons through the compaction_end error message", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "per-turn-cap" as const,
						reason: "per-turn compaction cap reached",
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow(/[Cc]ompaction/);

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toBeDefined();
		expect(compactionEnd?.accepted).toBe(false);
		expect(compactionEnd?.rejectionCause).toBe("per-turn-cap");
		expect(compactionEnd?.errorMessage ?? "").toContain("per-turn compaction cap reached");
	});
});

describe("Regression: interactive-mode compaction_end fallback", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders an error when a compaction_end carries no result, no errorMessage, and no aborted flag", async () => {
		const statusContainer = new Container();
		const chatContainer = new Container();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined as { stop(): void } | undefined,
			autoCompactionProgressText: "",
			defaultEditor: {} as { onEscape?: () => void },
			session: { abortCompaction: vi.fn() },
			statusContainer: Object.assign(statusContainer, { clear: vi.fn() }),
			chatContainer: Object.assign(chatContainer, { clear: vi.fn(), addChild: vi.fn() }),
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual";
				result: undefined;
				aborted: false;
				willRetry: false;
				accepted?: false;
				rejectionCause?: "would-overflow";
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			accepted: false,
			rejectionCause: "would-overflow",
		});

		expect(fakeThis.showError).toHaveBeenCalledTimes(1);
		const message = String(fakeThis.showError.mock.calls[0]?.[0] ?? "");
		expect(message).toMatch(/compaction/i);
		expect(message).toMatch(/would-overflow|unknown|no result/i);
	});
});
