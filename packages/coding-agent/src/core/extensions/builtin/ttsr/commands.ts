import type { ExtensionAPI } from "../../types.ts";
import { COLLAPSE_RULE_NAME, CONTROL_LEAK_RULE_NAME } from "./prompts.ts";
import type { TtsrDisabledBy } from "./settings.ts";
import {
	COLLAPSE_REMEDIATION,
	CONTROL_LEAK_REMEDIATION,
	type RuleRemediation,
	type TtsrRule,
	type TtsrScope,
} from "./types.ts";

export interface TtsrPublicState {
	readonly rules: readonly TtsrRule[];
	readonly injectedRuleNames: readonly string[];
	readonly disabled: boolean;
	readonly disabledBy: TtsrDisabledBy | null;
}

function formatStatus(state: TtsrPublicState): string {
	if (!state.disabled) return "enabled";
	return state.disabledBy === "settings"
		? "disabled (ttsr.enabled is false in settings)"
		: "disabled (ttsr-disabled flag set)";
}

interface BuiltinRuleStatus {
	readonly name: string;
	readonly detector: string;
	readonly remediation: RuleRemediation;
	readonly summary: string;
}

const BUILTIN_RULES: readonly BuiltinRuleStatus[] = [
	{
		name: COLLAPSE_RULE_NAME,
		detector: "collapse",
		remediation: COLLAPSE_REMEDIATION,
		summary: "abort the stream, truncate the garbage from history, inject a corrective nudge, then continue",
	},
	{
		name: CONTROL_LEAK_RULE_NAME,
		detector: "control-leak",
		remediation: CONTROL_LEAK_REMEDIATION,
		summary: "abort the stream, replace the generation with an error shell, then resample via bounded provider retry",
	},
];

export function registerTtsrCommands(pi: ExtensionAPI, getState: () => TtsrPublicState): void {
	pi.registerCommand("ttsr", {
		description: "Show TTSR stream-rule status: builtin detectors, user rules, injected rules.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatTtsrStatus(getState()), "info");
		},
	});
}

function formatTtsrStatus(state: TtsrPublicState): string {
	const builtinRules = state.rules.filter((rule) => rule.source === "builtin");
	const userRules = state.rules.filter((rule) => rule.source !== "builtin");
	return [
		"TTSR stream rules",
		"",
		"STATUS",
		formatStatus(state),
		"",
		"BUILTIN RULES",
		"DETECTORS",
		...BUILTIN_RULES.map(formatBuiltinRule),
		"STREAM RULES",
		...(builtinRules.length === 0 ? ["(none)"] : builtinRules.map(formatBuiltinStreamRule)),
		"",
		"USER RULES",
		...formatUserRules(userRules),
		"",
		"INJECTED",
		state.injectedRuleNames.length === 0 ? "(none)" : state.injectedRuleNames.join(", "),
	].join("\n");
}

function formatBuiltinRule(rule: BuiltinRuleStatus): string {
	return [
		`${rule.name} [detector: ${rule.detector}]`,
		`remediation: ${rule.summary}`,
		`(mode: ${rule.remediation.retryMode}, scope: ${rule.remediation.corruptionScope})`,
	].join(" ");
}

function formatBuiltinStreamRule(rule: TtsrRule): string {
	return `${rule.name} [stream rule, scope: ${formatScope(rule.scope)}]`;
}

function formatUserRules(rules: readonly TtsrRule[]): string[] {
	if (rules.length === 0) return ["(none)"];
	return rules.map((rule) => `${rule.name} [${rule.source}, scope: ${formatScope(rule.scope)}]`);
}

function formatScope(scope: TtsrScope): string {
	const parts: string[] = [];
	if (scope.allowText) parts.push("text");
	if (scope.allowThinking) parts.push("thinking");
	for (const toolScope of scope.toolScopes) {
		parts.push(
			toolScope.pathGlob === undefined
				? `tool:${toolScope.toolName}`
				: `tool:${toolScope.toolName}(${toolScope.pathGlob})`,
		);
	}
	return parts.length === 0 ? "none" : parts.join("+");
}
