export type TtsrStreamSource = "text" | "thinking" | "tool";

export interface TtsrToolScope {
	readonly toolName: string;
	readonly pathGlob?: string;
}

export interface TtsrScope {
	readonly allowText: boolean;
	readonly allowThinking: boolean;
	readonly toolScopes: readonly TtsrToolScope[];
}

export type TtsrInterruptMode = "always" | "never";

export interface TtsrRule {
	readonly name: string;
	readonly path?: string;
	readonly content: string;
	readonly description?: string;
	readonly globs?: readonly string[];
	readonly condition: readonly string[];
	readonly scope: TtsrScope;
	readonly interruptMode: TtsrInterruptMode;
	readonly source: "builtin" | "project" | "global";
}

export interface TtsrSettings {
	readonly enabled: boolean;
	readonly repeatMode: "once" | "after-gap";
	readonly repeatGap: number;
	readonly disabledRules: readonly string[];
}

export const DEFAULT_TTSR_SETTINGS: TtsrSettings = {
	enabled: true,
	repeatMode: "once",
	repeatGap: 10,
	disabledRules: [],
};

export interface DetectorContext {
	readonly source: TtsrStreamSource;
	readonly streamKey: string;
	readonly generation: number;
}

export interface DetectorMatch {
	readonly rule: "collapse-repetition" | "control-token-leak" | "repetitive-turns";
	readonly reason: string;
	readonly anomalyStartOffset: number;
	readonly garbageStartOffset: number;
	readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export interface StreamDetector<State> {
	createState(): State;
	checkDelta(state: State, delta: string, ctx: DetectorContext): DetectorMatch | null;
	flush?(state: State, ctx: DetectorContext): DetectorMatch | null;
}

export type TtsrContextMode = "keep" | "truncate" | "discard";

export type RuleRemediation =
	| {
			readonly retryMode: "nudge";
			readonly contextMode: TtsrContextMode;
			readonly corruptionScope: "output-region";
			readonly nudgeKey: string;
	  }
	| {
			readonly retryMode: "provider-error";
			readonly contextMode: "discard";
			readonly corruptionScope: "generation";
			readonly errorKind: "control-token-leak";
	  };

export const COLLAPSE_REMEDIATION: RuleRemediation = {
	retryMode: "nudge",
	contextMode: "truncate",
	corruptionScope: "output-region",
	nudgeKey: "collapse-repetition",
};

export const CONTROL_LEAK_REMEDIATION: RuleRemediation = {
	retryMode: "provider-error",
	contextMode: "discard",
	corruptionScope: "generation",
	errorKind: "control-token-leak",
};

export interface DetectionResolution {
	readonly owner: "collapse-repetition" | "control-token-leak";
	readonly observedRules: readonly ("collapse-repetition" | "control-token-leak")[];
	readonly match: DetectorMatch;
	readonly remediation: RuleRemediation;
}

export interface GenerationDetectionState {
	abortClaimed: boolean;
	abortOwner?: DetectionResolution["owner"];
	selfAbortAt?: number;
	userCancelled: boolean;
}

export interface TtsrInjectionRecord {
	readonly rules: readonly string[];
	readonly owner: DetectionResolution["owner"];
	readonly remediation: RuleRemediation["retryMode"];
	readonly at: number;
}

export const TTSR_INJECTION_CUSTOM_TYPE = "ttsr-injection";
