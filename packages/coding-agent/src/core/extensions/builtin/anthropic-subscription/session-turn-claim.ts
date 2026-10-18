import { Buffer } from "node:buffer";
import type { SDKMessage } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionSessionEntry, AnthropicSubscriptionSessionRegistry } from "./session-registry.ts";
import { transitionToTurnClaimed, transitionToTurnStreaming } from "./session-registry-state.ts";
import type { ActiveTurn } from "./session-turn-types.ts";

export function deliver(entry: AnthropicSubscriptionSessionEntry, turn: ActiveTurn, message: SDKMessage): void {
	if (entry.state === "TURN_CLAIMED") transitionToTurnStreaming(entry);
	turn.messages.push(message);
	turn.onMessage?.(message);
}

/**
 * Claude Code echoes a submitted prompt before that turn's first API call, on the same ordered stream,
 * so events ahead of our replay belong to a turn it is already running (an autonomous turn or a
 * background subagent). Only main-thread events are held, as a bounded courtesy for an early event; a
 * segment that outgrows the caps is another turn's and is dropped until that turn ends (senpi#2192).
 */
export function bufferBeforeReplay(
	registry: AnthropicSubscriptionSessionRegistry,
	entry: AnthropicSubscriptionSessionEntry,
	turn: ActiveTurn,
	message: Extract<SDKMessage, { type: "stream_event" }>,
): void {
	if (message.parent_tool_use_id !== null || turn.preReplayOverflowed) return;
	turn.preReplay.push(message);
	turn.preReplayBytes += Buffer.byteLength(JSON.stringify(message));
	if (turn.preReplay.length > turn.limits.maxMessages || turn.preReplayBytes > turn.limits.maxBytes) {
		dropPreReplay(turn);
		turn.preReplayOverflowed = true;
		return;
	}
	if (!registry.isCurrentGeneration(entry.senpiSessionId, turn.generation)) turn.preReplay.length = 0;
}

export function endForeignTurnBeforeReplay(turn: ActiveTurn): void {
	dropPreReplay(turn);
	turn.preReplayOverflowed = false;
}

function dropPreReplay(turn: ActiveTurn): void {
	turn.preReplay.length = 0;
	turn.preReplayBytes = 0;
}

export function claimTurn(entry: AnthropicSubscriptionSessionEntry, turn: ActiveTurn): SDKMessage[] {
	turn.claimed = true;
	transitionToTurnClaimed(entry);
	const buffered = turn.preReplay.splice(0);
	turn.preReplayBytes = 0;
	return buffered;
}

export function isReplayFor(message: SDKMessage, uuid: string): boolean {
	return message.type === "user" && "isReplay" in message && message.isReplay === true && message.uuid === uuid;
}

export function isAutonomousResult(message: Extract<SDKMessage, { type: "result" }>): boolean {
	if (message.origin && message.origin.kind !== "human") return true;
	const wire = message as SDKMessage & {
		parent_tool_use_id?: unknown;
		subagent_type?: unknown;
		isSynthetic?: unknown;
	};
	return wire.parent_tool_use_id != null || wire.subagent_type != null || wire.isSynthetic === true;
}

export function isForeignResult(message: Extract<SDKMessage, { type: "result" }>, turn: ActiveTurn): boolean {
	if ("user_message_uuid" in message && message.user_message_uuid !== undefined) {
		return message.user_message_uuid !== turn.uuid;
	}
	return isAutonomousResult(message);
}

export function resultMatchesTurn(message: Extract<SDKMessage, { type: "result" }>, turn: ActiveTurn): boolean {
	if ("user_message_uuid" in message && message.user_message_uuid !== undefined) {
		return message.user_message_uuid === turn.uuid;
	}
	return turn.claimed && !isAutonomousResult(message);
}
