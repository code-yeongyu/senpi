import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions, ThinkingBudgets, ThinkingLevel } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import {
	PROJECT_RULES_END_MARKER,
	PROJECT_RULES_HEADING,
	PROJECT_RULES_REGION_END_MARKER,
	PROJECT_RULES_REGION_START_MARKER,
	PROJECT_RULES_START_MARKER,
} from "../rules/rules/constants.ts";
import { presetAppendDeprecationGuidance } from "./guidance.ts";
import type { EffortLevel, Options, SettingSource, ThinkingConfig } from "./sdk-boundary.ts";
import {
	type ClaudeSdkOauthProviderSettings,
	type ClaudeSdkOauthSystemPromptMode,
	type ClaudeSdkOauthTokenInjection,
	loadClaudeSdkOauthProviderSettingsFromDisk,
	resolveSystemPromptMode,
} from "./settings.ts";
import { loadOverrideSystemPrompt, resolveCustomSystemPrompt } from "./system-prompt.ts";
import { BUILTIN_SDK_TOOLS, canUseTool, HOST_TOOL_DENIAL_HOOKS } from "./tools.ts";

export type ClaudeSdkOauthAuthLane = ClaudeSdkOauthTokenInjection;

export interface ClaudeSdkOauthQueryOptionsInput {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly streamOptions?: SimpleStreamOptions;
	readonly cwd?: string;
	readonly providerSettings?: ClaudeSdkOauthProviderSettings;
	readonly authLane?: ClaudeSdkOauthAuthLane;
	readonly tools?: readonly string[];
	readonly pathToClaudeCodeExecutable?: string;
	readonly sessionId?: string;
	readonly onGuidance?: (text: string) => void;
}

const ADAPTIVE_THINKING_MODEL_MARKERS = [
	"opus-4-6",
	"opus-4.6",
	"opus-4-7",
	"opus-4.7",
	"opus-4-8",
	"opus-4.8",
	"opus-5",
	"sonnet-4-6",
	"sonnet-4.6",
	"sonnet-5",
	"fable-5",
	"mythos-5",
] as const;

const NATIVE_XHIGH_EFFORT_MODEL_MARKERS = [
	"opus-4-7",
	"opus-4-8",
	"opus-5",
	"sonnet-5",
	"fable-5",
	"mythos-5",
] as const;

const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
	minimal: 2048,
	low: 8192,
	medium: 16384,
	high: 31999,
	max: 63999,
};

function includesModelMarker(model: Model<Api>, markers: readonly string[]): boolean {
	const id = model.id.toLowerCase();
	return markers.some((marker) => id.includes(marker));
}

function forcedAdaptiveThinking(model: Model<Api>): boolean | undefined {
	const compat = model.compat;
	if (!compat || !("forceAdaptiveThinking" in compat)) return undefined;
	return typeof compat.forceAdaptiveThinking === "boolean" ? compat.forceAdaptiveThinking : undefined;
}

function supportsAdaptiveThinking(model: Model<Api>): boolean {
	return forcedAdaptiveThinking(model) ?? includesModelMarker(model, ADAPTIVE_THINKING_MODEL_MARKERS);
}

function supportsNativeXhighEffort(model: Model<Api>): boolean {
	return includesModelMarker(model, NATIVE_XHIGH_EFFORT_MODEL_MARKERS);
}

function isEffortLevel(value: string): value is EffortLevel {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function mapThinkingLevelToEffort(model: Model<Api>, level: ThinkingLevel): EffortLevel {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string" && isEffortLevel(mapped)) return mapped;
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return supportsNativeXhighEffort(model) ? "xhigh" : "max";
		case "max":
			return "max";
	}
}

function mapThinkingTokens(reasoning: ThinkingLevel, thinkingBudgets: ThinkingBudgets | undefined): number {
	const budgetLevel = reasoning === "xhigh" ? "high" : reasoning;
	const customBudget = thinkingBudgets?.[budgetLevel];
	return typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0
		? customBudget
		: DEFAULT_THINKING_BUDGETS[budgetLevel];
}

function findAgentsMdInParents(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function sanitizeAgentsContent(content: string): string {
	const configDirectory = CONFIG_DIR_NAME.replace(/^\./, "");
	const escapedConfigDirectory = configDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return content
		.replace(new RegExp(`~/${escapedConfigDirectory}\\b`, "gi"), "~/.claude")
		.replace(new RegExp(`(^|[\\s'"\`])\\.${escapedConfigDirectory}/`, "g"), "$1.claude/")
		.replace(new RegExp(`\\b${escapedConfigDirectory}\\b`, "gi"), "environment");
}

function extractAgentsAppend(cwd: string): string | undefined {
	const agentsPath = findAgentsMdInParents(cwd) ?? join(getAgentDir(), "AGENTS.md");
	if (!existsSync(agentsPath)) return undefined;
	try {
		const content = sanitizeAgentsContent(readFileSync(agentsPath, "utf-8").trim());
		return content.length > 0 ? `# CLAUDE.md\n\n${content}` : undefined;
	} catch {
		return undefined;
	}
}

function rewriteSkillsLocations(skillsBlock: string, cwd: string): string {
	const globalSkillsRoot = join(getAgentDir(), "skills");
	const projectSkillsRoot = join(cwd, CONFIG_DIR_NAME, "skills");
	return skillsBlock.replace(/<location>([^<]+)<\/location>/g, (_match, location: string) => {
		if (location.startsWith(globalSkillsRoot)) {
			return `<location>~/.claude/skills/${relative(globalSkillsRoot, location).replace(/^\.+/, "")}</location>`;
		}
		if (location.startsWith(projectSkillsRoot)) {
			return `<location>.claude/skills/${relative(projectSkillsRoot, location).replace(/^\.+/, "")}</location>`;
		}
		return `<location>${location}</location>`;
	});
}

function extractSkillsAppend(systemPrompt: string | undefined, cwd: string): string | undefined {
	if (!systemPrompt) return undefined;
	const marker = "The following skills provide specialized instructions for specific tasks.";
	const start = systemPrompt.indexOf(marker);
	const end = start === -1 ? -1 : systemPrompt.indexOf("</available_skills>", start);
	if (end === -1) return undefined;
	return rewriteSkillsLocations(systemPrompt.slice(start, end + "</available_skills>".length).trim(), cwd);
}

/**
 * This lane rebuilds the prompt from the `claude_code` preset plus `append`, so any
 * region of senpi's composed prompt without an extractor here never reaches the model.
 *
 * Located by the rules builtin's opaque region sentinels rather than the model-facing
 * `<project_rules>` tags, which surrounding prompt content may legitimately contain.
 * The sentinels are a reserved wire literal but nothing neutralizes them outside the block, so
 * each candidate is structurally validated and rejected candidates are skipped - otherwise a
 * context file carrying one would shadow the real block or cross-match its end sentinel.
 * Fail-closed on a missing end sentinel: never read to end-of-string, or the sections
 * extensions append after this one get relabelled as project rules.
 */
function extractProjectRulesAppend(systemPrompt: string | undefined): string | undefined {
	if (!systemPrompt) return undefined;
	let searchFrom = 0;
	while (searchFrom <= systemPrompt.length) {
		const sentinelStart = systemPrompt.indexOf(PROJECT_RULES_REGION_START_MARKER, searchFrom);
		if (sentinelStart === -1) return undefined;
		const regionStart = sentinelStart + PROJECT_RULES_REGION_START_MARKER.length;
		const regionEnd = systemPrompt.indexOf(PROJECT_RULES_REGION_END_MARKER, regionStart);
		if (regionEnd === -1) return undefined;
		const region = systemPrompt.slice(regionStart, regionEnd).trim();
		if (isProjectRulesEnvelope(region)) return region;
		searchFrom = regionStart;
	}
	return undefined;
}

function isProjectRulesEnvelope(region: string): boolean {
	return (
		region.startsWith(`${PROJECT_RULES_START_MARKER}\n${PROJECT_RULES_HEADING}\n`) &&
		region.endsWith(`\n${PROJECT_RULES_END_MARKER}`)
	);
}

function resolveSettingSources(
	providerSettings: ClaudeSdkOauthProviderSettings,
	mode: ClaudeSdkOauthSystemPromptMode,
	authLane: ClaudeSdkOauthAuthLane,
): SettingSource[] {
	if (providerSettings.settingSources !== undefined) return [...providerSettings.settingSources];
	if (mode !== "preset-append" || authLane !== "ambient") return [];
	return ["user", "project"];
}

export function buildClaudeSdkOauthQueryOptions(input: ClaudeSdkOauthQueryOptionsInput): Options {
	const cwd = input.cwd ?? process.cwd();
	const providerSettings = input.providerSettings ?? loadClaudeSdkOauthProviderSettingsFromDisk(cwd);
	const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
	const resolvedMode = resolveSystemPromptMode(providerSettings);
	const mode = resolvedMode.mode;
	if (input.sessionId !== undefined && input.onGuidance !== undefined) {
		const deprecation = presetAppendDeprecationGuidance({
			mode,
			conflict: resolvedMode.conflict,
			sessionId: input.sessionId,
		});
		if (deprecation !== undefined) input.onGuidance(deprecation);
	}
	const authLane = input.authLane ?? providerSettings.tokenInjection ?? "ambient";
	const append =
		mode === "preset-append"
			? [
					extractAgentsAppend(cwd),
					extractSkillsAppend(input.context.systemPrompt, cwd),
					extractProjectRulesAppend(input.context.systemPrompt),
				].filter((part): part is string => part !== undefined)
			: [];
	const systemPrompt =
		mode === "preset-append"
			? { type: "preset" as const, preset: "claude_code" as const, append: append.join("\n\n") || undefined }
			: mode === "override"
				? loadOverrideSystemPrompt(providerSettings.systemPromptFile)
				: resolveCustomSystemPrompt(input.context.systemPrompt);
	const strictMcpConfig = providerSettings.strictMcpConfig ?? !appendSystemPrompt;
	const queryOptions: Options = {
		cwd,
		model: input.model.id,
		tools: input.tools ? [...input.tools] : [...BUILTIN_SDK_TOOLS],
		permissionMode: "dontAsk",
		includePartialMessages: true,
		canUseTool,
		hooks: HOST_TOOL_DENIAL_HOOKS,
		systemPrompt,
		settings: { autoCompactEnabled: true },
		settingSources: resolveSettingSources(providerSettings, mode, authLane),
	};
	if (input.pathToClaudeCodeExecutable) queryOptions.pathToClaudeCodeExecutable = input.pathToClaudeCodeExecutable;
	if (strictMcpConfig) queryOptions.extraArgs = { "strict-mcp-config": null };

	const reasoning = input.streamOptions?.reasoning;
	if (reasoning && supportsAdaptiveThinking(input.model)) {
		queryOptions.thinking = { type: "adaptive", display: "summarized" } satisfies ThinkingConfig;
		queryOptions.effort = mapThinkingLevelToEffort(input.model, reasoning);
	} else if (reasoning) {
		queryOptions.maxThinkingTokens = mapThinkingTokens(reasoning, input.streamOptions?.thinkingBudgets);
	}
	return queryOptions;
}
