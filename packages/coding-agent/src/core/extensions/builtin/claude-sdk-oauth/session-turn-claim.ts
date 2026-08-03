import { Buffer } from "node:buffer";
import type { SDKMessage } from "./sdk-boundary.ts";
import type { ClaudeSdkOauthSessionEntry, ClaudeSdkOauthSessionRegistry } from "./session-registry.ts";
import { transitionToTurnClaimed, transitionToTurnStreaming } from "./session-registry-state.ts";
import type { ActiveTurn } from "./session-turn-types.ts";
import { SessionTurnAttributionError } from "./session-turn-types.ts";

export function deliver(entry: ClaudeSdkOauthSessionEntry, turn: ActiveTurn, message: SDKMessage): void {
	if (entry.state === "TURN_CLAIMED") transitionToTurnStreaming(entry);
	turn.messages.push(message);
	turn.onMessage?.(message);
}

export function bufferBeforeReplay(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	turn: ActiveTurn,
	message: SDKMessage,
): void {
	turn.preReplay.push(message);
	turn.preReplayBytes += Buffer.byteLength(JSON.stringify(message));
	if (turn.preReplay.length > turn.limits.maxMessages || turn.preReplayBytes > turn.limits.maxBytes) {
		throw new SessionTurnAttributionError("Claude SDK OAuth pre-replay buffer overflow");
	}
	if (!registry.isCurrentGeneration(entry.senpiSessionId, turn.generation)) turn.preReplay.length = 0;
}

export function claimTurn(entry: ClaudeSdkOauthSessionEntry, turn: ActiveTurn): void {
	turn.claimed = true;
	transitionToTurnClaimed(entry);
	for (const buffered of turn.preReplay) deliver(entry, turn, buffered);
	turn.preReplay.length = 0;
	turn.preReplayBytes = 0;
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

export function resultMatchesTurn(message: Extract<SDKMessage, { type: "result" }>, turn: ActiveTurn): boolean {
	if ("user_message_uuid" in message && message.user_message_uuid !== undefined) {
		return message.user_message_uuid === turn.uuid;
	}
	return turn.claimed && !isAutonomousResult(message);
}
