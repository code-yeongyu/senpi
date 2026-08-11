import type { ExtensionAPI } from "../types.ts";

type AssistantMessageLike = {
	role: "assistant";
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
};

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

export default function (pi: ExtensionAPI) {
	let activeAssistantStartMs: number | null = null;
	let assistantElapsedMs = 0;

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

	pi.on("agent_start", () => {
		activeAssistantStartMs = null;
		assistantElapsedMs = 0;
	});

	pi.on("message_start", (event) => {
		if (!isAssistantMessage(event.message)) return;

		finishActiveAssistantTiming();
		activeAssistantStartMs = performance.now();
	});

	pi.on("message_end", (event) => {
		if (!isAssistantMessage(event.message)) return;

		finishActiveAssistantTiming();
	});

	pi.on("agent_end", (event, ctx) => {
		finishActiveAssistantTiming();

		const elapsedMs = assistantElapsedMs;
		activeAssistantStartMs = null;
		assistantElapsedMs = 0;

		if (!ctx.hasUI) return;
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
		const tokensPerSecond = output / elapsedSeconds;
		const promptTokens = input + cacheRead + cacheWrite;
		const cacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
		const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. Cache hit ${cacheHitRate.toFixed(1)}%, ${elapsedSeconds.toFixed(1)}s`;
		ctx.ui.notify(message, "info");
	});
}
