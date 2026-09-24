import {
	parseRuleActivationDetails,
	RULE_ACTIVATION_ENTRY_TYPE,
} from "../../../core/extensions/builtin/rule-activation/types.ts";
import type { CustomEntryComponent } from "./custom-entry.ts";
import type { ExplorationGroup } from "./exploration-group.ts";

/** Undefined for stream rules, legacy notices without a tool call id, and calls outside the group. */
export function projectRulesOfCall(
	card: CustomEntryComponent,
	calls: ExplorationGroup["calls"],
): readonly string[] | undefined {
	const entry = card.customEntry;
	if (entry.customType !== RULE_ACTIVATION_ENTRY_TYPE) return undefined;
	const details = parseRuleActivationDetails(entry.data);
	if (details?.kind !== "project-rules" || details.toolCallId === undefined) return undefined;
	const toolCallId = details.toolCallId;
	return calls.some(({ component }) => component.presentationSnapshot.identity.toolCallId === toolCallId)
		? details.rules
		: undefined;
}
