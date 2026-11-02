import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextEstimateOptions } from "./compaction/compaction.ts";
import type { ModelChangeEntry, SessionEntry } from "./session-manager.ts";

/**
 * Provider usage counts the context with the answering model's tokenizer, so after a model switch the last
 * usage describes the previous model, not the selected one (oh-my-openagent#11684). These helpers decide
 * which usage still describes the selected model; context figures estimate the rest from the transcript.
 */

export interface SessionAppendOrder {
	getMessageEntryPosition(message: AgentMessage): Readonly<{ entryId: string; order: number }> | undefined;
	getEntryOrder(entryId: string): number | undefined;
}

function getLatestModelChangeEntry(branch: readonly SessionEntry[]): ModelChangeEntry | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "model_change") return entry;
	}
	return undefined;
}

export function getLatestModelSwitchTime(branch: readonly SessionEntry[]): number | undefined {
	const modelSwitch = getLatestModelChangeEntry(branch);
	return modelSwitch === undefined ? undefined : Date.parse(modelSwitch.timestamp);
}

/**
 * Whether `message` was reported after `modelSwitch`, by append order. A response still streaming when a mid-turn
 * switch landed is persisted after the entry yet was measured by the previous model, so its request time decides
 * for such a switch. A response awaiting persistence otherwise started after the switch; a message with no runtime
 * identity (reconstructed) falls back to its timestamp.
 */
function usageFollowsModelSwitch(
	message: AssistantMessage,
	modelSwitch: ModelChangeEntry,
	sessionOrder: SessionAppendOrder,
	awaitingPersistence: boolean,
): boolean {
	const switchedAt = Date.parse(modelSwitch.timestamp);
	if (modelSwitch.duringTurn === true && message.timestamp < switchedAt) return false;
	if (awaitingPersistence) return true;
	const position = sessionOrder.getMessageEntryPosition(message);
	const switchOrder = sessionOrder.getEntryOrder(modelSwitch.id);
	if (position !== undefined && switchOrder !== undefined) return position.order > switchOrder;
	return message.timestamp >= switchedAt;
}

export function modelSwitchEstimateOptions(
	branch: readonly SessionEntry[],
	sessionOrder: SessionAppendOrder,
	isAwaitingPersistence: (message: AssistantMessage) => boolean,
): ContextEstimateOptions {
	const modelSwitch = getLatestModelChangeEntry(branch);
	if (modelSwitch === undefined) return {};
	return {
		usageCounts: (message) =>
			usageFollowsModelSwitch(message, modelSwitch, sessionOrder, isAwaitingPersistence(message)),
	};
}
