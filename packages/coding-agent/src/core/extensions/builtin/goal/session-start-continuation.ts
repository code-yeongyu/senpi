import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../messages.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	admitAndQueueGoalContinuation,
	buildCurrentGoalContinuationSignature,
	isLastTurnStuckOnContextOverflow,
	lastAssistantText,
} from "./lifecycle-helpers.ts";
import { buildContinuationPrompt } from "./prompt.ts";
import { isLimitRefusal } from "./provider-retry.ts";
import type { Goal } from "./types.ts";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

export type TrailingGoalContinuations = {
	/** Continuations whose turn ran: the unattended loop the load-time flood guard bounds. */
	readonly counted: number;
	/** The newest continuation was refused for a usage or rate limit, so the goal was waiting that limit out. */
	readonly waitingOutLimit: boolean;
};

export type SessionStartContinuationOptions = {
	readonly continuationPending: boolean;
	readonly markContinuationPending: () => void;
	/** The session opened in the middle of a limit wait, so this wake re-checks that limit (senpi#4085). */
	readonly limitWait?: boolean;
};

/**
 * Reads the goal continuations queued since the most recent real user message in the branch (mirrors the
 * todo-gate / todo-bridge backward branch read). A real user message is the only reset: the assistant turns in
 * between are exactly the unattended loop the load-time admission guard exists to stop.
 *
 * A continuation the provider refused for a usage or rate limit ran no model turn, so it is not part of that
 * loop (senpi#4085). A goal that waited a limit out for more wakes than the cap is therefore not a flood, and it
 * resumes after a restart or a config reload.
 */
export function readTrailingGoalContinuations(entries: readonly SessionEntry[]): TrailingGoalContinuations {
	let counted = 0;
	let waitingOutLimit: boolean | undefined;
	let turn: AssistantAgentMessage[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message") {
			if (entry.message.role === "user") break;
			if (entry.message.role === "assistant") turn.push(entry.message);
			continue;
		}
		if (entry?.type !== "custom_message" || entry.customType !== GOAL_CONTINUATION_MESSAGE_TYPE) continue;
		const refused = wasRefusedForLimit(turn);
		waitingOutLimit ??= refused;
		if (!refused) counted += 1;
		turn = [];
	}
	return { counted, waitingOutLimit: waitingOutLimit ?? false };
}

function wasRefusedForLimit(turn: readonly AssistantAgentMessage[]): boolean {
	return (
		turn.length > 0 &&
		turn.every((message) => message.stopReason === "error") &&
		turn.some((message) => isLimitRefusal([message]))
	);
}

/** Routes startup and resume continuations through the same verdict and delivery accounting as agent-end paths. */
export async function queueGoalContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: Goal,
	options: SessionStartContinuationOptions,
): Promise<Goal | null> {
	const lastAssistant = lastAssistantFromEntries(ctx.sessionManager.getBranch());
	const signature = buildCurrentGoalContinuationSignature(
		ctx,
		goal,
		lastAssistant === undefined ? "" : lastAssistantText([lastAssistant]),
	);
	return admitAndQueueGoalContinuation(pi, ctx, goal, {
		input: {
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			path: "sessionStart",
			lastStopReason: undefined,
			lastTurnWasMalformedToolUse: false,
			consecutiveContinuations: goal.consecutiveContinuations ?? 0,
			lastContinuationSignature: goal.lastContinuationSignature,
			currentSignature: signature,
			consecutiveLengthRecoveries: 0,
			recentNormalizedOutputHashes: [],
			toollessContinuationStreak: 0,
			continuationPending: options.continuationPending,
			lastTurnStuckOnContextOverflow: isLastTurnStuckOnContextOverflow(ctx, lastAssistant),
			...(options.limitWait === true ? { limitWait: true } : {}),
		},
		content: () => buildContinuationPrompt(goal, { modelId: ctx.model?.id }),
		markContinuationPending: options.markContinuationPending,
	});
}

function lastAssistantFromEntries(entries: readonly SessionEntry[]): AssistantAgentMessage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") return entry.message;
	}
	return undefined;
}
