import type { SessionBeforeForkEvent, SessionBeforeSwitchEvent, TreePreparation } from "../../core/extensions/types.ts";
import type { BranchSummaryEntry } from "../../core/session-manager.ts";
import {
	isBoolean,
	isNullableString,
	isOneOf,
	isOptional,
	isRecord,
	isSessionEntries,
	isSessionEntry,
	isString,
	loopHookFamily,
	malformed,
	forwarded,
} from "./loop-hook-payloads.ts";

// A hosted loop's session navigation (senpi#5898): `session_before_switch`, `session_before_fork` and
// `session_before_tree` return their combined result (the last one, the first `cancel` ending the walk) as a session's
// emit does; `session_tree` is a notification.

const SWITCH_REASONS = ["new", "resume"] as const satisfies readonly SessionBeforeSwitchEvent["reason"][];
const FORK_POSITIONS = ["before", "at"] as const satisfies readonly SessionBeforeForkEvent["position"][];

function treePreparationOf(value: unknown): TreePreparation {
	if (!isRecord(value)) throw malformed("session_before_tree");
	const { targetId, oldLeafId, commonAncestorId, entriesToSummarize, userWantsSummary } = value;
	const { customInstructions, replaceInstructions, label } = value;
	if (
		!isString(targetId) ||
		!isNullableString(oldLeafId) ||
		!isNullableString(commonAncestorId) ||
		!isSessionEntries(entriesToSummarize) ||
		!isBoolean(userWantsSummary) ||
		!isOptional(customInstructions, isString) ||
		!isOptional(replaceInstructions, isBoolean) ||
		!isOptional(label, isString)
	)
		throw malformed("session_before_tree");
	return {
		targetId,
		oldLeafId,
		commonAncestorId,
		entriesToSummarize,
		userWantsSummary,
		...(customInstructions === undefined ? {} : { customInstructions }),
		...(replaceInstructions === undefined ? {} : { replaceInstructions }),
		...(label === undefined ? {} : { label }),
	};
}

const isBranchSummary = (value: unknown): value is BranchSummaryEntry =>
	isSessionEntry(value) && value.type === "branch_summary" && isString(value.fromId) && isString(value.summary);

export const SESSION_LOOP_HOOKS = loopHookFamily({
	session_before_switch: ({ reason, targetSessionFile }) => {
		if (!isOneOf(reason, SWITCH_REASONS) || !isOptional(targetSessionFile, isString))
			throw malformed("session_before_switch");
		return forwarded({
			type: "session_before_switch",
			reason,
			...(targetSessionFile === undefined ? {} : { targetSessionFile }),
		});
	},
	session_before_fork: ({ entryId, position }) => {
		if (!isString(entryId) || !isOneOf(position, FORK_POSITIONS)) throw malformed("session_before_fork");
		return forwarded({ type: "session_before_fork", entryId, position });
	},
	session_before_tree: (payload) => {
		const preparation = treePreparationOf(payload.preparation);
		return {
			emit: ({ runner, only, signal }) =>
				runner.emitForwardedLoopEvent({ type: "session_before_tree", preparation, signal }, only),
		};
	},
	session_tree: ({ newLeafId, oldLeafId, summaryEntry, fromExtension }) => {
		if (
			!isNullableString(newLeafId) ||
			!isNullableString(oldLeafId) ||
			!isOptional(summaryEntry, isBranchSummary) ||
			!isOptional(fromExtension, isBoolean)
		)
			throw malformed("session_tree");
		return forwarded({
			type: "session_tree",
			newLeafId,
			oldLeafId,
			...(summaryEntry === undefined ? {} : { summaryEntry }),
			...(fromExtension === undefined ? {} : { fromExtension }),
		});
	},
});
