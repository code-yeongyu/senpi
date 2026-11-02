import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { markTransientMessage } from "../compaction/estimate-cache-key.ts";
import { getSessionContextEntryId, SESSION_CONTEXT_ENTRY_ID } from "../session-manager.ts";
import type {
	ContextEvent,
	ContextEventResult,
	ContextWithSystemEvent,
	Extension,
	ExtensionContext,
	ExtensionError,
} from "./types.ts";

type HandlerSnapshot = { ext: Extension; handlers: NonNullable<ReturnType<Extension["handlers"]["get"]>> };

function cloneJsonValue<T>(value: T): T {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error("Expected JSON-serializable value");
	}
	return JSON.parse(serialized);
}

function sameMessages(left: AgentMessage[], right: AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * Re-attach the prompt and tool state after a `context` handler. Handlers only see the
 * conversation; the system messages belong to Pi. An unchanged conversation keeps every
 * system message in place, so models with mid-conversation support keep their cached
 * prefix. A changed one gets the replayed prompt sections and tool declarations as one
 * leading system message, so pruning, windowing, or slicing from a compaction summary
 * cannot drop them.
 */
function restoreSystemMessages(
	current: AgentMessage[],
	visible: AgentMessage[],
	returned: AgentMessage[],
): AgentMessage[] {
	if (sameMessages(returned, visible)) return current;
	const head = getCurrentSystemMessage(current);
	return head ? [head, ...returned] : returned;
}

export async function dispatchContextMessages(
	messages: AgentMessage[],
	input: {
		contextHandlers: HandlerSnapshot[];
		contextWithSystemHandlers: HandlerSnapshot[];
		createContext: (extensionPath: string) => ExtensionContext;
		emitError: (error: ExtensionError) => void;
		excludeExtensionPath?: string;
		source: ContextEvent["source"];
	},
): Promise<AgentMessage[]> {
	// The deep copy exists to isolate the transcript from in-place handler edits
	// (senpi#2525). Handlers registered with `{ mutatesMessages: false }` forgo in-place
	// edits, so when every handler of both context phases about to run declares it, the
	// live transcript objects are shared and per-turn cost is proportional to what the
	// handlers actually change. Any undeclared handler keeps the historical clone.
	// Both phases are snapshotted once, here: a handler registered while an earlier one runs must
	// not join this pass, or it could see the shared live transcript without having declared
	// `mutatesMessages: false` (review of senpi#2884, H1). It runs from the next request on.
	const contextHandlers = input.contextHandlers;
	const contextWithSystemHandlers = input.contextWithSystemHandlers;
	const handlersShareTranscript = [contextHandlers, contextWithSystemHandlers].every((snapshot) =>
		snapshot.every(
			({ ext, handlers }) =>
				ext.path === input.excludeExtensionPath ||
				handlers.every((handler) => ext.nonMutatingContextHandlers?.has(handler) === true),
		),
	);
	let currentMessages = handlersShareTranscript
		? messages.slice()
		: cloneJsonValue(messages).map((message, index) => {
				const entryId = getSessionContextEntryId(messages[index]!);
				// A per-turn clone never repeats, so the estimators skip their caches for it.
				return markTransientMessage(
					entryId ? Object.assign(message, { [SESSION_CONTEXT_ENTRY_ID]: entryId }) : message,
				);
			});

	for (const { ext, handlers } of contextHandlers) {
		if (ext.path === input.excludeExtensionPath) continue;
		for (const handler of handlers) {
			try {
				// Without system messages there is nothing to hide or restore, so the handler gets the
				// working list itself and the list it sees is the list the request carries.
				const hasSystemMessages = currentMessages.some((message) => message.role === "system");
				const visibleMessages = hasSystemMessages
					? currentMessages.filter((message) => message.role !== "system")
					: currentMessages;
				const visibleSnapshot = visibleMessages.slice();
				const event: ContextEvent = { type: "context", messages: visibleMessages, source: input.source };
				const handlerResult = (await handler(event, input.createContext(ext.path))) as
					| ContextEventResult
					| undefined;

				// Handlers may return a new list or edit event.messages in place.
				const returned =
					handlerResult?.messages ??
					(sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
				if (!returned) continue;
				currentMessages = hasSystemMessages
					? restoreSystemMessages(currentMessages, visibleSnapshot, returned)
					: returned;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				input.emitError({
					extensionPath: ext.path,
					event: "context",
					error: message,
					stack,
				});
			}
		}
	}

	for (const { ext, handlers } of contextWithSystemHandlers) {
		if (ext.path === input.excludeExtensionPath) continue;
		for (const handler of handlers) {
			try {
				const hadLeadingSystemMessage = currentMessages[0]?.role === "system";
				const event: ContextWithSystemEvent = { type: "context_with_system", messages: currentMessages };
				const handlerResult = (await handler(event, input.createContext(ext.path))) as
					| ContextEventResult
					| undefined;
				currentMessages = handlerResult?.messages ?? currentMessages;
				// Providers read the prompt and initial tools from the leading system message.
				// Losing it is never intended; report it but honor the handler's output.
				if (hadLeadingSystemMessage && currentMessages[0]?.role !== "system") {
					input.emitError({
						extensionPath: ext.path,
						event: "context_with_system",
						error: "Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().",
					});
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				input.emitError({
					extensionPath: ext.path,
					event: "context_with_system",
					error: message,
					stack,
				});
			}
		}
	}

	return currentMessages;
}
