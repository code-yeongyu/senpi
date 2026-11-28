import type { HistoryReducer } from "../../../session-history-reduce.ts";
import { parseRuleActivationDetails, RULE_ACTIVATION_ENTRY_TYPE } from "../rule-activation/types.ts";
import { TTSR_INJECTION_CUSTOM_TYPE } from "./types.ts";

/**
 * The rule names TTSR injected in a session's history, in order, which a new manager restores. Folded, so a rebuilt
 * extension reads only the entries appended since instead of the whole history (senpi#7607).
 */
export const injectedTtsrRules: HistoryReducer<string[]> = {
	initial: () => [],
	add: (names, entry) => {
		if (entry.type !== "custom") return names;
		if (entry.customType === RULE_ACTIVATION_ENTRY_TYPE) {
			const details = parseRuleActivationDetails(entry.data);
			if (details?.kind === "ttsr") names.push(...details.rules);
			return names;
		}
		if (entry.customType !== TTSR_INJECTION_CUSTOM_TYPE) return names;
		const data = entry.data;
		if (typeof data !== "object" || data === null || !("rules" in data)) return names;
		const rules = (data as { rules?: unknown }).rules;
		if (Array.isArray(rules)) names.push(...rules.filter((rule): rule is string => typeof rule === "string"));
		return names;
	},
};
