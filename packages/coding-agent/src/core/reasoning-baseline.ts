import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isValidThinkingLevel } from "../cli/args.ts";
import type { SessionEntry } from "./session-manager.ts";

/**
 * The request-level effort of every request while a session holds a `configuration_update`: the baseline
 * the model's prompt cache was built with, so effort changes travel only as `configuration_update` items
 * (senpi#2094, senpi#4116). Without a valid baseline it is the live level.
 */
export function requestThinkingLevel(baseline: string | undefined, thinkingLevel: ThinkingLevel): ThinkingLevel {
	return baseline !== undefined && isValidThinkingLevel(baseline) ? baseline : thinkingLevel;
}

/**
 * Whether the newest `configuration_update` in a transcript names another level than the live one. On a flagged
 * model that update is the effort the request carries, so a level that arrived without one (a fallback rung's
 * level) would otherwise leave the older update in force (senpi#6655).
 */
export function hasStaleConfigurationUpdate(
	messages: readonly { role: string; effort?: string }[],
	thinkingLevel: ThinkingLevel,
): boolean {
	const newest = messages.findLast((message) => message.role === "configurationUpdate");
	return newest !== undefined && newest.effort !== thinkingLevel;
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
