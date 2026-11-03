import { reasonedBeforeFirstDelta, STREAMED_DELTA_TYPES } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "../types.ts";

type AssistantMessageLike = {
	role: "assistant";
	stopReason?: string;
	content?: ReadonlyArray<{ type?: string }>;
	usage?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
};

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

/** Below this much streamed generation time a rate is mostly timer noise, so none is shown (senpi#3393). */
const MIN_GENERATION_MS = 500;

export default function (pi: ExtensionAPI) {
	let activeAssistantStartMs: number | null = null;
	let assistantElapsedMs = 0;
	let messageStartMs: number | null = null;
	let firstDeltaMs: number | null = null;
	let thinkingStreamed = false;
	let lastDeltaMs: number | null = null;
	let generationMs = 0;
	let streamedOutput = 0;

	const finishActiveAssistantTiming = () => {
		if (activeAssistantStartMs === null) return;

		// Use the monotonic clock so a wall-clock jump backward (NTP skew or
		// manual time change) between message_start and message_end cannot
		// produce a non-positive interval that suppresses a valid TPS notice.
		const elapsedMs = performance.now() - activeAssistantStartMs;
		if (elapsedMs > 0) {
			assistantElapsedMs += elapsedMs;
		}
		activeAssistantStartMs = null;
	};

	const resetStreamWindow = () => {
		messageStartMs = null;
		firstDeltaMs = null;
		lastDeltaMs = null;
		thinkingStreamed = false;
	};

	pi.on("agent_start", () => {
		activeAssistantStartMs = null;
		assistantElapsedMs = 0;
		generationMs = 0;
		streamedOutput = 0;
		resetStreamWindow();
	});

	pi.on("message_start", (event) => {
		if (!isAssistantMessage(event.message)) return;

		finishActiveAssistantTiming();
		resetStreamWindow();
		activeAssistantStartMs = performance.now();
		messageStartMs = activeAssistantStartMs;
	});

	pi.on("message_update", (event) => {
		if (!isAssistantMessage(event.message)) return;
		if (!STREAMED_DELTA_TYPES.has(event.assistantMessageEvent.type)) return;

		const now = performance.now();
		if (event.assistantMessageEvent.type === "thinking_delta") thinkingStreamed = true;
		firstDeltaMs ??= now;
		lastDeltaMs = now;
	});

	pi.on("message_end", (event) => {
		if (!isAssistantMessage(event.message)) return;

		finishActiveAssistantTiming();
		// The rate counts only messages that streamed, timed from their first token to their last, so
		// time-to-first-token and a reply delivered in one piece cannot skew it (senpi#3393). Reasoning
		// counted in usage.output may be hidden or only summarised after it finished, so it was generated
		// before the first delta. Such a message (usage.reasoning, or a thinking block whose text never
		// streamed: Bedrock and omitted display report no reasoning count) is timed from its start.
		const output = event.message.usage?.output ?? 0;
		const windowStart = reasonedBeforeFirstDelta(event.message, thinkingStreamed) ? messageStartMs : firstDeltaMs;
		const counted = event.message.stopReason !== "aborted" && event.message.stopReason !== "error" && output > 0;
		if (counted && windowStart !== null && lastDeltaMs !== null && lastDeltaMs > windowStart) {
			generationMs += lastDeltaMs - windowStart;
			streamedOutput += output;
		}
		resetStreamWindow();
	});

	pi.on("agent_end", (event, ctx) => {
		finishActiveAssistantTiming();

		const elapsedMs = assistantElapsedMs;
		const measuredGenerationMs = generationMs;
		const measuredOutput = streamedOutput;
		activeAssistantStartMs = null;
		assistantElapsedMs = 0;
		generationMs = 0;
		streamedOutput = 0;
		resetStreamWindow();

		if (!ctx.hasUI) return;
		// senpi#3236: the per-run stats notice is a TUI footer nicety; in RPC
		// mode ctx.ui.notify becomes an extension_ui_request that surfaces as a
		// "Work Log" row on the desktop. Only the TUI shows it.
		if (ctx.mode !== "tui") return;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage?.input ?? 0;
			output += message.usage?.output ?? 0;
			cacheRead += message.usage?.cacheRead ?? 0;
			cacheWrite += message.usage?.cacheWrite ?? 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const promptTokens = input + cacheRead + cacheWrite;
		const cacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
		const stats = `Cache hit ${cacheHitRate.toFixed(1)}%, ${elapsedSeconds.toFixed(1)}s`;
		const rate =
			measuredGenerationMs >= MIN_GENERATION_MS && measuredOutput > 0
				? `TPS ${(measuredOutput / (measuredGenerationMs / 1000)).toFixed(1)} tok/s. `
				: "";
		ctx.ui.notify(`${rate}${stats}`, "info");
	});
}
