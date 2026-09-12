import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ContinuityNoticeTracker } from "../src/modes/interactive/components/continuity-notice.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { StreamingRevealController } from "../src/modes/interactive/streaming-reveal.ts";
import { getMarkdownTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent(event: AgentSessionEvent): Promise<void> })
	.handleEvent;

type StreamingSurface = {
	isInitialized: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	toolOutputExpanded: boolean;
	chatContainer: Container;
	assistantTextSegments: Map<number, AssistantMessageComponent>;
	pendingTools: Map<string, never>;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	runtimeHost: { session: Harness["session"] };
	continuityNotices: ContinuityNoticeTracker;
	toolArgsReveal: { flush: () => boolean; flushAll: () => void };
	getMarkdownThemeWithSettings: () => ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers: () => [];
	footer: { invalidate: () => void };
	ui: { requestRender: () => void };
	streamingReveal: StreamingRevealController;
};

/**
 * Minimal surface for the real handleEvent message_start/message_update/
 * message_end (assistant) path: real AssistantMessageComponent, real chat
 * container, and the REAL StreamingRevealController wired to the harness
 * settings manager, so smooth-streaming pacing runs exactly as in production.
 * The surface inherits InteractiveMode.prototype so private helpers
 * (syncTrailingAssistantText et al.) run for real against this state.
 */
function createStreamingSurface(harness: Harness): StreamingSurface {
	const surface = Object.create(InteractiveMode.prototype) as StreamingSurface;
	return Object.assign(surface, {
		isInitialized: true,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: false,
		chatContainer: new Container(),
		assistantTextSegments: new Map(),
		pendingTools: new Map(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		runtimeHost: { session: harness.session },
		continuityNotices: new ContinuityNoticeTracker(),
		toolArgsReveal: { flush: () => false, flushAll: () => {} },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		streamingReveal: new StreamingRevealController({
			getSmoothStreaming: () => harness.settingsManager.getSmoothStreaming(),
			getSmoothStreamingFps: () => harness.settingsManager.getSmoothStreamingFps(),
			getHideThinkingBlock: () => false,
			requestRender: () => {},
		}),
	});
}

type Paint = { event: string; text: string };

describe("streaming head single-writer (smooth streaming)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("never shrinks the streaming component's painted text while the reveal paces the head", async () => {
		const harness = await createHarness({ settings: { smoothStreaming: true } });
		harnesses.push(harness);
		const surface = createStreamingSurface(harness);

		// Record EVERY paint pushed into the streaming component (from both the
		// reveal controller and syncTrailingAssistantText) between message_start
		// and message_end. The dual-write regression paints full-head then a
		// paced prefix, so the sequence shrinks.
		const paints: Paint[] = [];
		let currentEvent = "before-stream";
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
				return;
			}
			if (event.message.role !== "assistant") return;
			currentEvent = event.type;
			const handled = handleEvent.call(surface, event);
			if (event.type === "message_start" && surface.streamingComponent) {
				const component = surface.streamingComponent;
				const original = component.updateContent.bind(component);
				component.updateContent = (message: AssistantMessage, isStreaming?: boolean) => {
					paints.push({ event: currentEvent, text: getMessageText(message) });
					return original(message, isStreaming);
				};
			}
			return handled;
		});

		const streamedText = Array.from({ length: 30 }, (_, index) => `token-${index}`).join(" ");
		harness.setResponses([fauxAssistantMessage(streamedText)]);
		await harness.session.prompt("stream");
		await harness.session.waitForIdle();
		unsubscribe();

		const updates = harness.events.filter(
			(event) => event.type === "message_update" && event.message.role === "assistant",
		);
		expect(updates.length).toBeGreaterThanOrEqual(2);

		const lengths = paints.map((paint) => paint.text.length);
		const firstShrink = lengths.findIndex((length, index) => index > 0 && length < (lengths[index - 1] ?? 0));
		expect(
			firstShrink,
			`streaming head paints must never shrink (single writer); got lengths [${lengths.join(", ")}] for events [${paints.map((paint) => paint.event).join(", ")}]`,
		).toBe(-1);

		// message_end must still flush the complete head once the reveal stops.
		expect(paints[paints.length - 1]?.text).toBe(streamedText);
	});
});
