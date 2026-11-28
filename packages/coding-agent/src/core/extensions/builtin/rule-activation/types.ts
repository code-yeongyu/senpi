export const RULE_ACTIVATION_ENTRY_TYPE = "rule-activation";

export interface ProjectRulesActivationDetails {
	readonly kind: "project-rules";
	readonly targetPath: string;
	readonly rules: readonly string[];
	/** The tool call whose result the rules were injected into; absent on entries written before it existed. */
	readonly toolCallId?: string;
}

/** Scalar facts a stream detector measured, such as `mechanism`, counts and a capped `sample`. */
export type TtsrDetectionDetail = Readonly<Record<string, string | number | boolean>>;

export interface TtsrActivationDetails {
	readonly kind: "ttsr";
	readonly owner: string;
	readonly rules: readonly string[];
	readonly remediation: "nudge" | "provider-error";
	/** Which stream the detector fired in; absent on entries written before it existed and for pattern rules. */
	readonly stream?: "text" | "thinking" | "tool";
	/** The detector's own explanation of the hit, so a false positive can be told from a real loop. */
	readonly reason?: string;
	readonly detail?: TtsrDetectionDetail;
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
	const stream = Reflect.get(value, "stream");
	const reason = Reflect.get(value, "reason");
	const detail = scalarRecord(Reflect.get(value, "detail"));
	return {
		kind: "ttsr",
		owner,
		rules,
		remediation,
		...(stream === "text" || stream === "thinking" || stream === "tool" ? { stream } : {}),
		...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
		...(detail === undefined ? {} : { detail }),
	};
}

/** Malformed optional detail is dropped; it never invalidates the activation that carries it. */
function scalarRecord(value: unknown): TtsrDetectionDetail | undefined {
	if (!isObject(value)) return undefined;
	const entries = Object.entries(value);
	return entries.length > 0 && entries.every(([, field]) => ["string", "number", "boolean"].includes(typeof field))
		? (value as TtsrDetectionDetail)
		: undefined;
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
