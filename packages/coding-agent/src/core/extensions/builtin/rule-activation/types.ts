export const RULE_ACTIVATION_ENTRY_TYPE = "rule-activation";

export interface ProjectRulesActivationDetails {
	readonly kind: "project-rules";
	readonly targetPath: string;
	readonly rules: readonly string[];
	/** The tool call whose result the rules were injected into; absent on entries written before it existed. */
	readonly toolCallId?: string;
}

export interface TtsrActivationDetails {
	readonly kind: "ttsr";
	readonly owner: string;
	readonly rules: readonly string[];
	readonly remediation: "nudge" | "provider-error";
}

export type RuleActivationDetails = ProjectRulesActivationDetails | TtsrActivationDetails;

export function parseRuleActivationDetails(value: unknown): RuleActivationDetails | undefined {
	if (!isObject(value)) return undefined;
	const kind = Reflect.get(value, "kind");
	switch (kind) {
		case "project-rules":
			return parseProjectRulesActivation(value);
		case "ttsr":
			return parseTtsrActivation(value);
		default:
			return undefined;
	}
}

function parseProjectRulesActivation(value: object): ProjectRulesActivationDetails | undefined {
	const targetPath = Reflect.get(value, "targetPath");
	const rules = stringList(Reflect.get(value, "rules"));
	if (typeof targetPath !== "string" || targetPath.length === 0 || rules === undefined) return undefined;
	const toolCallId = Reflect.get(value, "toolCallId");
	return {
		kind: "project-rules",
		targetPath,
		rules,
		...(typeof toolCallId === "string" && toolCallId.length > 0 ? { toolCallId } : {}),
	};
}

function parseTtsrActivation(value: object): TtsrActivationDetails | undefined {
	const owner = Reflect.get(value, "owner");
	const rules = stringList(Reflect.get(value, "rules"));
	const remediation = Reflect.get(value, "remediation");
	if (
		typeof owner !== "string" ||
		owner.length === 0 ||
		rules === undefined ||
		(remediation !== "nudge" && remediation !== "provider-error")
	) {
		return undefined;
	}
	return { kind: "ttsr", owner, rules, remediation };
}

function stringList(value: unknown): readonly string[] | undefined {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every((entry) => typeof entry === "string" && entry.length > 0)
	) {
		return undefined;
	}
	return value;
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
