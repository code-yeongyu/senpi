import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolvePromptSurface } from "../../../dynamic-prompt/build.ts";
import type { ExtensionAPI } from "../../types.ts";
import { stripAgentScaffold } from "./scaffold-strip.ts";

export { type ScaffoldStrip, stripAgentScaffold } from "./scaffold-strip.ts";

/**
 * Rewrites the visible text blocks of a finalized assistant message; tool calls, thinking and
 * model-only text stay as they are. A block that held only scaffolding keeps its slot with empty
 * text. Returns undefined when nothing was removed.
 */
export function scrubAssistantMessage(message: AssistantMessage): AssistantMessage | undefined {
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "text" || block.audience === "model") return block;
		const strip = stripAgentScaffold(block.text);
		if (strip.removed.length === 0) return block;
		changed = true;
		return { ...block, text: strip.text };
	});
	return changed ? { ...message, content } : undefined;
}

/**
 * On the chat surface (senpi#2398) a finalized assistant message loses a leading routing line,
 * handoff blocks and ledger lines before event listeners, RPC clients and the session file see it.
 * Streamed `message_update` deltas are not rewritten.
 */
export default function chatReplyScrubExtension(pi: ExtensionAPI): void {
	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return undefined;
		const surface = ctx.getSystemPromptOptions?.().surface ?? resolvePromptSurface(process.env);
		if (surface !== "chat") return undefined;
		const scrubbed = scrubAssistantMessage(message);
		return scrubbed ? { message: scrubbed } : undefined;
	});
}
