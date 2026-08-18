import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { SettingsManager } from "../../../settings-manager.ts";
import { classifyReasoningCapability, type ReasoningCapability } from "../../../thinking-levels.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";

/**
 * Capability-aware `/reasoning` (the on/off axis) and `/efforts` (the effort ladder).
 *
 * Both commands classify the CURRENT model on every invocation through
 * `classifyReasoningCapability`, so a mid-session model switch is honored immediately and no
 * capability is ever cached. Neither command opens a selector: status is notified as text so both
 * work headless and over RPC.
 */

/** Effort ladder, ascending. `off` is deliberately absent: it is the /reasoning axis. */
const EFFORT_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** Tokens `/efforts` recognizes grammatically; support is then checked per model. */
const EFFORT_TOKENS: readonly string[] = ["off", ...EFFORT_LEVELS];
const REASONING_ARGUMENTS = ["on", "off"] as const;
const REASONING_USAGE = "Usage: /reasoning [on|off]";
const EFFORTS_USAGE = "Usage: /efforts [minimal|low|medium|high|xhigh|max]";
const DEFAULT_ON_LEVEL: ThinkingLevel = "medium";

type ReasoningArgument = (typeof REASONING_ARGUMENTS)[number];

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function noReasoningMessage(model: Model<Api>): string {
	return `Model ${modelKey(model)} does not support reasoning.`;
}

function onOffOnlyMessage(model: Model<Api>): string {
	return `Reasoning effort is not configurable for ${modelKey(model)}; this model supports on/off only. Use /reasoning on or /reasoning off.`;
}

function reasoningStatus(level: ThinkingLevel): string {
	return level === "off" ? "Reasoning: off." : `Reasoning: on (${level}).`;
}

function effortsStatus(level: ThinkingLevel, capability: ReasoningCapability): string {
	return `Reasoning effort: ${level}. Available: ${capability.nonOffLevels.join(", ")}.`;
}

/** The single argument token, `""` for the no-arg form, or `null` when more than one token was given. */
function parseSingleArgument(args: string): string | null {
	const trimmed = args.trim();
	if (trimmed.length === 0) return "";
	const tokens = trimmed.split(/\s+/);
	return tokens.length === 1 ? (tokens[0] ?? "") : null;
}

/**
 * Clamp to the nearest supported non-off level, searching upward first and then downward — the
 * same direction policy the session clamp uses, so a remembered level below a model's floor lands
 * on that floor instead of silently disabling reasoning.
 */
function clampToNonOff(level: ThinkingLevel, capability: ReasoningCapability): ThinkingLevel | undefined {
	const supported = new Set(capability.nonOffLevels);
	if (supported.has(level)) return level;
	const index = EFFORT_LEVELS.indexOf(level);
	if (index === -1) return capability.nonOffLevels[0];
	for (let i = index; i < EFFORT_LEVELS.length; i++) {
		const candidate = EFFORT_LEVELS[i];
		if (candidate && supported.has(candidate)) return candidate;
	}
	for (let i = index - 1; i >= 0; i--) {
		const candidate = EFFORT_LEVELS[i];
		if (candidate && supported.has(candidate)) return candidate;
	}
	return capability.nonOffLevels[0];
}

/**
 * Level to restore when reasoning is switched back on: this model's durable last non-off level,
 * else a legacy non-off effective memory, else the global default when that is not "off", else
 * medium — always clamped to what the model supports.
 */
function resolvePreferredOnLevel(
	ctx: ExtensionCommandContext,
	model: Model<Api>,
	capability: ReasoningCapability,
): ThinkingLevel | undefined {
	const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });
	const lastOnLevel = settingsManager.getModelLastOnThinkingLevel(model.provider, model.id);
	const remembered = settingsManager.getModelThinkingLevel(model.provider, model.id);
	const globalDefault = settingsManager.getDefaultThinkingLevel();
	const preferred = lastOnLevel ?? nonOff(remembered) ?? nonOff(globalDefault) ?? DEFAULT_ON_LEVEL;
	return clampToNonOff(preferred, capability);
}

function createSettingsManager(ctx: ExtensionCommandContext): SettingsManager {
	return SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });
}

function nonOff(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
	return level !== undefined && level !== "off" ? level : undefined;
}

function toCompletions(values: readonly string[], prefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = prefix.trim();
	const matches = values.filter((value) => value.startsWith(normalizedPrefix));
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

export default function reasoningExtension(pi: ExtensionAPI): void {
	// Completions run outside a command context, which carries no model, so the live model is
	// tracked from the events that change it. Handlers always read ctx.model instead.
	let currentModel: Model<Api> | undefined;

	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model;
	});
	pi.on("model_select", (event) => {
		currentModel = event.model;
	});

	pi.registerCommand("reasoning", {
		description: "Show or toggle reasoning for the current model",
		argumentHint: "[on|off]",
		getArgumentCompletions: (prefix) => toCompletions(REASONING_ARGUMENTS, prefix),
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model is active.", "error");
				return;
			}
			currentModel = model;

			const argument = parseSingleArgument(args);
			if (argument === null || (argument !== "" && !REASONING_ARGUMENTS.includes(argument as ReasoningArgument))) {
				ctx.ui.notify(REASONING_USAGE, "error");
				return;
			}

			const capability = classifyReasoningCapability(model);
			const currentLevel = pi.getThinkingLevel();

			if (argument === "") {
				ctx.ui.notify(reasoningStatus(currentLevel), "info");
				return;
			}

			if (argument === "off") {
				if (capability.kind === "none") {
					// Nothing to disable; the model is already, permanently, off.
					ctx.ui.notify(reasoningStatus("off"), "info");
					return;
				}
				if (capability.kind === "always-on") {
					ctx.ui.notify(`Reasoning cannot be disabled for ${modelKey(model)}.`, "error");
					return;
				}
				if (currentLevel !== "off") {
					const settingsManager = createSettingsManager(ctx);
					settingsManager.setModelLastOnThinkingLevel(model.provider, model.id, currentLevel);
					await settingsManager.flush();
				}
				pi.setThinkingLevel("off");
				ctx.ui.notify(reasoningStatus(pi.getThinkingLevel()), "info");
				return;
			}

			if (capability.kind === "none") {
				ctx.ui.notify(noReasoningMessage(model), "error");
				return;
			}

			// Already reasoning: re-persist the current level instead of overriding the user's choice.
			if (currentLevel !== "off") {
				pi.setThinkingLevel(currentLevel);
				ctx.ui.notify(reasoningStatus(pi.getThinkingLevel()), "info");
				return;
			}

			const target = resolvePreferredOnLevel(ctx, model, capability);
			if (target === undefined) {
				ctx.ui.notify(noReasoningMessage(model), "error");
				return;
			}

			// Apply the clamped level to the session, but persist it without rewriting a stale raw
			// last-on preference. If catalog support returns later, the original preference still wins.
			pi.setSessionThinkingLevel(target);
			const settingsManager = createSettingsManager(ctx);
			settingsManager.setModelThinkingLevel(model.provider, model.id, target, { preserveLastOn: true });
			settingsManager.setDefaultThinkingLevel(target);
			await settingsManager.flush();
			ctx.ui.notify(reasoningStatus(pi.getThinkingLevel()), "info");
		},
	});

	pi.registerCommand("efforts", {
		description: "Show or set the reasoning effort for the current model",
		argumentHint: "[minimal|low|medium|high|xhigh|max]",
		getArgumentCompletions: (prefix) => {
			// Only a graded model has an effort ladder worth completing.
			const capability = currentModel ? classifyReasoningCapability(currentModel) : undefined;
			if (capability?.kind !== "graded") return null;
			return toCompletions(capability.nonOffLevels, prefix);
		},
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model is active.", "error");
				return;
			}
			currentModel = model;

			const argument = parseSingleArgument(args);
			if (argument === null || (argument !== "" && !EFFORT_TOKENS.includes(argument))) {
				ctx.ui.notify(EFFORTS_USAGE, "error");
				return;
			}

			const capability = classifyReasoningCapability(model);
			if (capability.kind === "none") {
				ctx.ui.notify(noReasoningMessage(model), "error");
				return;
			}
			if (capability.kind === "on-off") {
				ctx.ui.notify(onOffOnlyMessage(model), "error");
				return;
			}

			if (argument === "") {
				ctx.ui.notify(effortsStatus(pi.getThinkingLevel(), capability), "info");
				return;
			}

			const level = argument as ThinkingLevel;
			if (!capability.nonOffLevels.includes(level)) {
				ctx.ui.notify(
					`Reasoning effort "${level}" is not supported by ${modelKey(model)}. Available: ${capability.nonOffLevels.join(", ")}.`,
					"error",
				);
				return;
			}

			pi.setThinkingLevel(level);
			ctx.ui.notify(effortsStatus(pi.getThinkingLevel(), capability), "info");
		},
	});
}
