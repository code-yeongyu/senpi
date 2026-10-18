import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export function sdkAlignmentReductionHistory(answer: AssistantMessage): AgentMessage[] {
	return [
		{ role: "user", content: "u1", timestamp: 1 },
		answer,
		{ role: "user", content: "u2", timestamp: 3 },
		// Keep five messages and over 3,000 recent tokens outside the old answer.
		...Array.from({ length: 5 }, (_, index) => ({
			role: "user" as const,
			content: "recent ".repeat(400),
			timestamp: 4 + index,
		})),
	];
}
