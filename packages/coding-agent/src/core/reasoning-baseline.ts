import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isValidThinkingLevel } from "../cli/args.ts";
import type { ConfigurationUpdateMessage } from "./messages.ts";
import type { SessionEntry } from "./session-manager.ts";

/**
 * The request-level effort of every request while a session holds a `configuration_update`: the baseline
 * the model's prompt cache was built with, so effort changes travel only as `configuration_update` items
 * (senpi#2094, senpi#4116). Without a valid baseline it is the live level.
 */
export function requestThinkingLevel(baseline: string | undefined, thinkingLevel: ThinkingLevel): ThinkingLevel {
	return baseline !== undefined && isValidThinkingLevel(baseline) ? baseline : thinkingLevel;
}

function isConfigurationUpdate(message: AgentMessage): message is ConfigurationUpdateMessage {
	return message.role === "configurationUpdate";
}

/**
 * The request context with the live level in force. On a flagged model the newest `configuration_update` is the
 * effort a request carries, and a level that arrived without one (a fallback rung's, a favourite cycle's) would
 * leave an older update in force. The live level rides the request only, never the session file, so a resumed
 * session keeps the user's level (senpi#6655). It goes before the turn's user message, like a recorded update.
 */
export function withLiveConfigurationUpdate(
	messages: AgentMessage[],
	thinkingLevel: ThinkingLevel,
	timestamp: number,
): AgentMessage[] {
	const newestIndex = messages.findLastIndex(isConfigurationUpdate);
	const newest = messages[newestIndex];
	if (newest === undefined || !isConfigurationUpdate(newest) || newest.effort === thinkingLevel) return messages;
	const update: ConfigurationUpdateMessage = {
		role: "configurationUpdate",
		content: [],
		effort: thinkingLevel,
		timestamp,
	};
	const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
	const at = lastUserIndex > newestIndex ? lastUserIndex : messages.length;
	return [...messages.slice(0, at), update, ...messages.slice(at)];
}

/**
 * The baseline a resumed session restores, replaying the rules `AgentSession` applies live: an in-model effort
 * change (a `thinking_level_change` immediately followed by its `configuration_update`) pins the level that was
 * active before it, and a switch to another model clears it, because the new model's cache starts empty.
 */
export function resumeReasoningBaseline(branch: readonly SessionEntry[]): string | undefined {
	let level: string | undefined;
	let levelBeforeChange: string | undefined;
	let previous: SessionEntry | undefined;
	let model: string | undefined;
	let baseline: string | undefined;
	for (const entry of branch) {
		if (entry.type === "thinking_level_change") {
			levelBeforeChange = level;
			level = entry.thinkingLevel;
		} else if (entry.type === "configuration_update" && previous?.type === "thinking_level_change") {
			baseline ??= levelBeforeChange;
		} else if (entry.type === "model_change") {
			const next = `${entry.provider}/${entry.modelId}`;
			if (next !== model) baseline = undefined;
			model = next;
		}
		previous = entry;
	}
	return baseline;
}
