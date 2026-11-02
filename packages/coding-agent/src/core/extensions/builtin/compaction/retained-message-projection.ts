import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { transformJson } from "../../../session-resident-json.ts";
import { hasUnsafeRetainedContent } from "./retained-message-safety.ts";

/** Bound normalized JSON before estimating tokens or replaying provider state. */
export function isSafeBoundedValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
	if (depth > 32) return false;
	if (value === null || value === undefined) return true;
	const kind = typeof value;
	if (kind === "string" || kind === "number" || kind === "boolean") return true;
	if (kind !== "object") return false;
	if (seen.has(value as object)) return false;
	seen.add(value as object);
	if (Array.isArray(value)) {
		for (const item of value) if (!isSafeBoundedValue(item, seen, depth + 1)) return false;
		return true;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
		if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
		if (!isSafeBoundedValue(descriptor.value, seen, depth + 1)) return false;
	}
	return true;
}

/**
 * #3060: a fallback projects the same JSON as the session writer, then omits unsafe
 * payloads rather than poisoning every suffix containing them. The positional
 * mapping is preserved so SessionManager can carry entry provenance onto copies.
 */
export function projectRetainedMessages(messages: AgentMessage[]): AgentMessage[] {
	const omittedCalls = new Set<string>();
	return messages.map((original): AgentMessage => {
		let message = original;
		let safe = false;
		try {
			// This is the serializer used by ResidentStringStore.externalize before
			// SessionManager writes JSONL, including toJSON, getters, Maps and Buffers.
			message = transformJson(original, (text) => text);
			safe = isSafeBoundedValue(message) && !hasUnsafeRetainedContent([message]);
		} catch {
			// A value the writer cannot serialize is not replayable either. Only the
			// minimal identity below may survive; never put the exception in context.
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
				if (safe) omittedCalls.delete(block.id);
				else omittedCalls.add(block.id);
			}
		}
		const orphanedByOmission = message.role === "toolResult" && omittedCalls.has(message.toolCallId);
		if (safe && !orphanedByOmission) return message;

		const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : 0;
		if (
			message.role === "toolResult" &&
			!orphanedByOmission &&
			typeof message.toolCallId === "string" &&
			message.toolCallId.length > 0 &&
			typeof message.toolName === "string" &&
			message.toolName.length > 0
		) {
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: [{ type: "text", text: "[tool result omitted from retained context: not replay-safe]" }],
				isError: true,
				timestamp,
			};
		}
		// Never strip a signature and replay the now-unsigned assistant/tool call.
		// Omit that assistant and its results together. For a user, retain readable
		// request text even when an attachment or envelope is malformed.
		const text =
			message.role === "user"
				? typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content
								.flatMap((block) =>
									block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
								)
								.join("\n")
						: ""
				: "";
		return {
			role: "user",
			content: `${text ? `${text}\n` : ""}[message omitted from retained context: not replay-safe]`,
			timestamp,
		};
	});
}
