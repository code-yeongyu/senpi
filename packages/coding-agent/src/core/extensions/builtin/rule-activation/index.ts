import type { ExtensionAPI } from "../../types.ts";
import { renderRuleActivationEntry } from "./renderer.ts";
import { RULE_ACTIVATION_ENTRY_TYPE, type RuleActivationDetails } from "./types.ts";

export {
	type ProjectRulesActivationDetails,
	RULE_ACTIVATION_ENTRY_TYPE,
	type RuleActivationDetails,
	type TtsrActivationDetails,
	type TtsrDetectionDetail,
} from "./types.ts";

export function registerRuleActivationRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(RULE_ACTIVATION_ENTRY_TYPE, renderRuleActivationEntry);
}

export function appendRuleActivation(pi: ExtensionAPI, details: RuleActivationDetails): void {
	pi.appendEntry(RULE_ACTIVATION_ENTRY_TYPE, details);
}
