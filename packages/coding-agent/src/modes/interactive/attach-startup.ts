import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AttachClient } from "./attach-client.ts";

export interface AttachPrompt {
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

/**
 * What a terminal's command line asks of a session it attached to on a host (senpi#6911): applied through the
 * session's own commands, in the order an in-process start applies them (model, thinking, then the prompts).
 */
export interface AttachStartup {
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinking?: ThinkingLevel;
	readonly prompts: readonly AttachPrompt[];
}

/** A refusal from the host rejects, so a model the session cannot use is never followed by the prompts. */
export async function applyAttachStartup(
	request: AttachClient["request"],
	sessionId: string,
	startup: AttachStartup,
): Promise<void> {
	if (startup.model) {
		await request({ type: "set_model", sessionId, ...startup.model });
	}
	if (startup.thinking) {
		await request({ type: "set_thinking_level", sessionId, level: startup.thinking });
	}
	for (const prompt of startup.prompts) {
		// A prompt sent while the session runs a turn waits behind it, like the next line typed at the editor.
		await request({
			type: "prompt",
			sessionId,
			message: prompt.text,
			...(prompt.images && prompt.images.length > 0 ? { images: [...prompt.images] } : {}),
			streamingBehavior: "followUp",
			clientMessageId: randomUUID(),
		});
	}
}
