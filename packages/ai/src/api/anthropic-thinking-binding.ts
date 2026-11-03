import type { Context, Message, Model } from "../types.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";

/**
 * A signed `thinking` block is bound to the conversation prefix it was minted under (senpi#5587). History
 * that carries a block from another prefix (a restored or transplanted transcript, a route that served an
 * earlier turn from another account) is refused before the first token:
 * "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different
 * conversation." The block is stored in the session, so every replay repeats the refusal.
 *
 * Two layers keep such a session usable:
 * - Where the API accepts it, a request that replays signed thinking asks the API to drop a mismatched
 *   block (`thinking.block_binding.prefix_mismatch_behavior: "drop_block"`).
 * - On exactly this 400 the request is rebuilt once, on the same model, without the replayed signed
 *   thinking; user text, tool calls and tool results are untouched. The removed turns are remembered per
 *   session, base URL and model, so later turns stay consistent with the prefix the retry was answered
 *   under and do not hit the 400 again.
 */

const BOUND_TO_DIFFERENT_CONVERSATION =
	/Invalid `signature` in `thinking` block\. The block is bound to a different conversation/i;
// A transport that does not know the binding controls names the field or the beta in its 400.
const BINDING_CONTROL_NAMED = /block_binding|thinking-binding-controls/i;

export const THINKING_BINDING_RECOVERY_DIAGNOSTIC = "anthropic_thinking_binding_recovery";

function statusOf(error: unknown): unknown {
	return typeof error === "object" && error !== null && "status" in error
		? (error as { status?: unknown }).status
		: undefined;
}

export function isThinkingBindingMismatchError(error: unknown): error is Error {
	return error instanceof Error && statusOf(error) === 400 && BOUND_TO_DIFFERENT_CONVERSATION.test(error.message);
}

export function isThinkingBindingMismatchText(text: string): boolean {
	return BOUND_TO_DIFFERENT_CONVERSATION.test(text);
}

/** A 400 refusing the binding control itself, as opposed to the mismatch it guards against. */
export function isThinkingBindingControlRefusedError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		statusOf(error) === 400 &&
		BINDING_CONTROL_NAMED.test(error.message) &&
		!BOUND_TO_DIFFERENT_CONVERSATION.test(error.message)
	);
}

/** The binding controls are an Anthropic API feature: only Claude models, on any route that serves them. */
export function acceptsThinkingBinding(model: Pick<Model<"anthropic-messages">, "id">): boolean {
	return /claude/i.test(model.id);
}

function signedThinkingCount(message: Message): number {
	if (message.role !== "assistant") return 0;
	let count = 0;
	for (const block of message.content) {
		if (block.type === "thinking" && (block.thinkingSignature?.length ?? 0) > 0) count++;
	}
	return count;
}

export function replaysSignedThinking(messages: readonly Message[]): boolean {
	return messages.some((message) => signedThinkingCount(message) > 0);
}

export function bindReplayedThinking<T extends { thinking?: unknown }>(params: T): void {
	const thinking = params.thinking;
	if (typeof thinking !== "object" || thinking === null) return;
	const config = thinking as { type?: unknown; block_binding?: unknown };
	if (config.type !== "adaptive" && config.type !== "enabled") return;
	if (config.block_binding !== undefined) return;
	params.thinking = { ...config, block_binding: { prefix_mismatch_behavior: "drop_block" } };
}

// `${sessionKey}\u0000${messageKey}` of assistant turns whose signed thinking was removed after this 400.
const rejectedThinkingTurns = new Set<string>();
// Session keys whose transport refused the binding controls.
const bindingRefusedSessions = new Set<string>();

registerSessionResourceCleanup((sessionId?: string) => {
	if (sessionId === undefined) {
		rejectedThinkingTurns.clear();
		bindingRefusedSessions.clear();
		return;
	}
	const prefix = `${sessionId}\u0000`;
	for (const keys of [rejectedThinkingTurns, bindingRefusedSessions]) {
		for (const key of keys) {
			if (key.startsWith(prefix)) keys.delete(key);
		}
	}
});

function turnKey(message: Message): string {
	return message.role === "assistant" ? (message.responseId ?? `${message.model}@${message.timestamp}`) : "";
}

export class ThinkingBindingRecovery {
	private readonly localTurns = new Set<string>();
	private localBindingRefused = false;
	private readonly sessionKey: string | undefined;

	constructor(sessionKey: string | undefined) {
		this.sessionKey = sessionKey;
	}

	get bindingAllowed(): boolean {
		if (this.localBindingRefused) return false;
		return this.sessionKey === undefined || !bindingRefusedSessions.has(this.sessionKey);
	}

	refuseBinding(): void {
		this.localBindingRefused = true;
		if (this.sessionKey !== undefined) bindingRefusedSessions.add(this.sessionKey);
	}

	private isRejected(message: Message): boolean {
		const key = turnKey(message);
		if (this.localTurns.has(key)) return true;
		return this.sessionKey !== undefined && rejectedThinkingTurns.has(`${this.sessionKey}\u0000${key}`);
	}

	rejectReplayedThinking(messages: readonly Message[]): number {
		let blocks = 0;
		for (const message of messages) {
			const count = signedThinkingCount(message);
			if (count === 0 || this.isRejected(message)) continue;
			blocks += count;
			const key = turnKey(message);
			this.localTurns.add(key);
			if (this.sessionKey !== undefined) rejectedThinkingTurns.add(`${this.sessionKey}\u0000${key}`);
		}
		return blocks;
	}

	strip<C extends Context>(context: C): { context: C; removed: boolean } {
		let removed = false;
		const messages = context.messages.map((message): Message => {
			if (message.role !== "assistant" || signedThinkingCount(message) === 0 || !this.isRejected(message)) {
				return message;
			}
			removed = true;
			const content = message.content.filter(
				(block) => !(block.type === "thinking" && (block.thinkingSignature?.length ?? 0) > 0),
			);
			return { ...message, content };
		});
		return removed ? { context: { ...context, messages }, removed } : { context, removed };
	}
}

export function thinkingBindingUnrecoverableError(cause: Error): Error {
	const error = new Error(
		`Anthropic rejected this session's earlier reasoning as bound to a different conversation, and the request rebuilt without it was rejected too. Start a new session to continue. (${cause.message})`,
		{ cause },
	);
	return Object.assign(error, { status: 400 });
}
