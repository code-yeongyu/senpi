import { noticeMessageRenderer } from "../../notice/index.ts";
import type { MessageRenderer } from "../../types.ts";
import type { LoopGuardDetection } from "./detectors.ts";
import type { LoopGuardEscalationDetails } from "./notice.ts";

export const renderLoopGuardNotice: MessageRenderer<LoopGuardDetection> = noticeMessageRenderer((message) => {
	const details = message.details;
	if (details === undefined) return undefined;
	return { title: titleLine(details), why: whyLine(details), expandedLine: expandedLine(details) };
});

export const renderLoopGuardEscalation: MessageRenderer<LoopGuardEscalationDetails> = noticeMessageRenderer(
	(message) => {
		const details = message.details;
		if (details === undefined) return undefined;
		return {
			title: `! Loop guard · turn interrupted (${details.toolName})`,
			tone: "error",
			why: `The agent ignored two warnings and repeated ${details.blockedCallCount} calls after blocking began.`,
			expandedLine: "A user-role recovery message was queued and the active turn was stopped by a system abort.",
		};
	},
);

function titleLine(detection: LoopGuardDetection): string {
	switch (detection.kind) {
		case "identical":
			return `⚠ Loop guard · identical calls ×${detection.count} (${detection.toolName})`;
		case "similar":
			return `⚠ Loop guard · near-identical calls ×${detection.count} (${detection.toolName})`;
		case "cycle":
			return `⚠ Loop guard · repeating pattern ×${detection.count} (period ${detection.period})`;
	}
}

function whyLine(detection: LoopGuardDetection): string {
	switch (detection.kind) {
		case "identical":
			return "Same tool, same arguments, again. The agent was told to reuse the result or change the call.";
		case "similar": {
			const percent = Math.round(detection.similarity * 100);
			return `Argument similarity ~${percent}%. The agent was told to verify this is distinct work, not a lazy loop.`;
		}
		case "cycle": {
			const pattern = detection.cycleTools.join(" -> ");
			return `Tool-call cycle [${pattern}]. The agent was told to break the rotation or justify the progress.`;
		}
	}
}

function expandedLine(detection: LoopGuardDetection): string {
	switch (detection.kind) {
		case "identical":
			return `tool ${detection.toolName} · ${detection.count} consecutive identical calls when the reminder fired`;
		case "similar":
			return `tool ${detection.toolName} · ${detection.count} consecutive same-tool calls at ~${Math.round(detection.similarity * 100)}% args similarity`;
		case "cycle":
			return `cycle ${detection.cycleTools.join(" -> ")} · ${detection.count} full repetitions in the tracked window`;
	}
}
