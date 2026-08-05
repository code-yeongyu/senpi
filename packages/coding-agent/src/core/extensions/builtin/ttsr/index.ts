import { getKeybindings } from "@earendil-works/pi-tui";

import type { AgentEndEvent, ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "../../types.ts";
import { appendRuleActivation, registerRuleActivationRenderer } from "../rule-activation/index.ts";
import { parseRuleActivationDetails, RULE_ACTIVATION_ENTRY_TYPE } from "../rule-activation/types.ts";
import { BUILTIN_TTSR_RULES } from "./builtin-rules.ts";
import { registerTtsrCommands, type TtsrPublicState } from "./commands.ts";
import { claimAbort, createGenerationState, markUserCancelled } from "./coordinator.ts";
import { REPETITIVE_TURNS_RULE_NAME } from "./detectors/repetitive-turns.ts";
import { discoverTtsrRulesSync } from "./discovery.ts";
import { TtsrManager } from "./manager.ts";
import { REPETITIVE_TURNS_RULE_CONTENT } from "./prompts.ts";
import { buildNudgeMessage, type TtsrNudgeMessage } from "./remediation.ts";
import { collectAssistantText, RepetitiveTurnsLane, readPersistedAssistantTexts } from "./repetitive-turns-lane.ts";
import { compileRuleCondition } from "./rule-condition.ts";
import { buildStreamRemediation } from "./stream-remediation.ts";
import {
	DEFAULT_TTSR_SETTINGS,
	type DetectionResolution,
	type GenerationDetectionState,
	TTSR_INJECTION_CUSTOM_TYPE,
	type TtsrRule,
} from "./types.ts";
import { StreamWatcher } from "./watch.ts";

interface PendingRemediation {
	readonly resolution: DetectionResolution;
	readonly streamKind: "text" | "thinking";
}

interface PendingRuleNudge {
	readonly rule: TtsrRule;
}

const INTERRUPT_KEYBINDING = "app.interrupt";

function isInterruptKey(data: string): boolean {
	try {
		return getKeybindings().matches(data, INTERRUPT_KEYBINDING);
	} catch {
		return false;
	}
}

function parseDisabledRules(raw: boolean | string | undefined): string[] {
	return typeof raw === "string" && raw.length > 0
		? raw
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0)
		: [];
}

export default function ttsrExtension(pi: ExtensionAPI): void {
	registerRuleActivationRenderer(pi);
	pi.registerFlag("ttsr-disabled", {
		type: "boolean",
		default: false,
		description: "Disable TTSR stream-rule detection.",
	});
	pi.registerFlag("ttsr-rules-disabled", {
		type: "string",
		default: "",
		description: "Comma-separated TTSR rule names to disable.",
	});

	let manager: TtsrManager | null = null;
	let watcher: StreamWatcher | null = null;
	let genState: GenerationDetectionState = createGenerationState();
	let generation = 0;
	let pendingRemediation: PendingRemediation | null = null;
	let pendingRuleNudge: PendingRuleNudge | null = null;
	let pendingNudge: TtsrNudgeMessage | null = null;
	let settlingAgentEnd: AgentEndEvent | null = null;
	let disabled = false;
	const repetitiveTurns = new RepetitiveTurnsLane();

	function cancelRemediation(): void {
		if (pendingRemediation !== null || pendingNudge !== null || pendingRuleNudge !== null) {
			markUserCancelled(genState);
			pendingRemediation = null;
			pendingRuleNudge = null;
			pendingNudge = null;
			repetitiveTurns.disarm();
		}
	}

	function resetGenerationState(): void {
		generation += 1;
		genState = createGenerationState();
		pendingRemediation = null;
		pendingRuleNudge = null;
		repetitiveTurns.resetTurn();
		watcher?.reset();
	}

	function recordInjection(owner: string, observed: readonly string[], retryMode: "nudge" | "provider-error"): void {
		appendRuleActivation(pi, {
			kind: "ttsr",
			owner,
			rules: observed,
			remediation: retryMode,
		});
	}

	function ensureInitialized(ctx: ExtensionContext): void {
		if (manager !== null) return;
		disabled = pi.getFlag("ttsr-disabled") === true;
		const disabledRules = parseDisabledRules(pi.getFlag("ttsr-rules-disabled"));
		repetitiveTurns.configure(new Set(disabledRules));
		const settings = { ...DEFAULT_TTSR_SETTINGS, enabled: !disabled, disabledRules };
		manager = new TtsrManager(settings, (pattern) => compileRuleCondition(pattern).regex);
		const injectedNames = ctx.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom") return [];
			if (entry.customType === RULE_ACTIVATION_ENTRY_TYPE) {
				const details = parseRuleActivationDetails(entry.data);
				return details?.kind === "ttsr" ? [...details.rules] : [];
			}
			if (entry.customType !== TTSR_INJECTION_CUSTOM_TYPE) return [];
			const data = entry.data;
			if (typeof data !== "object" || data === null || !("rules" in data)) return [];
			const rules = (data as { rules?: unknown }).rules;
			return Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === "string") : [];
		});
		manager.restoreInjected(injectedNames);
		for (const rule of BUILTIN_TTSR_RULES) {
			manager.addRule(rule);
		}
		const discovered = discoverTtsrRulesSync(ctx.cwd);
		for (const rule of discovered.rules) {
			manager.addRule(rule);
		}
		watcher = new StreamWatcher(manager, disabledRules);
		repetitiveTurns.restoreFromHistory(readPersistedAssistantTexts(ctx));
		if (ctx.mode === "tui") {
			try {
				ctx.ui.onTerminalInput((data) => {
					if (isInterruptKey(data)) cancelRemediation();
				});
			} catch {
				return;
			}
		}
	}

	function publicState(): TtsrPublicState {
		return {
			rules: manager?.getRules() ?? [],
			injectedRuleNames: manager?.getInjectedRuleNames() ?? [],
			disabled,
		};
	}

	registerTtsrCommands(pi, publicState);

	pi.on("session_start", (_event, ctx) => {
		ensureInitialized(ctx);
	});

	pi.on("session_abort", () => {
		cancelRemediation();
	});

	pi.on("input", () => {
		cancelRemediation();
	});

	pi.on("agent_end", (event) => {
		settlingAgentEnd = event;
		if (event.abortSource === "user") {
			cancelRemediation();
			return;
		}
		if (event.willRetry === true) resetGenerationState();
	});

	pi.on("turn_start", (_event, ctx) => {
		ensureInitialized(ctx);
		resetGenerationState();
	});

	pi.on("turn_end", () => {
		manager?.incrementMessageCount();
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
		ensureInitialized(ctx);
		if (disabled || manager === null || watcher === null) return;
		const deltaEvent = event.assistantMessageEvent;
		if (deltaEvent.type !== "text_delta" && deltaEvent.type !== "thinking_delta") return;
		const source = deltaEvent.type === "text_delta" ? "text" : "thinking";
		const streamKey = `${source}:${String(deltaEvent.contentIndex)}`;
		const outcome = watcher.handleDelta(source, streamKey, deltaEvent.delta, generation);
		if (outcome.resolution !== null && claimAbort(genState, outcome.resolution)) {
			pendingRemediation = { resolution: outcome.resolution, streamKind: source };
			ctx.abort("system");
			return;
		}
		if (source === "text") {
			const canArm = pendingRuleNudge === null && !genState.abortClaimed;
			if (repetitiveTurns.observeTextDelta(deltaEvent.delta, canArm) && !genState.abortClaimed) {
				genState.abortClaimed = true;
				genState.abortOwner = "collapse-repetition";
				genState.selfAbortAt = Date.now();
				ctx.abort("system");
				return;
			}
		}
		const interrupting = outcome.ruleMatches.filter((rule) => rule.interruptMode === "always");
		const rule = interrupting[0];
		if (rule !== undefined && pendingRuleNudge === null && !genState.abortClaimed) {
			genState.abortClaimed = true;
			genState.abortOwner = "collapse-repetition";
			genState.selfAbortAt = Date.now();
			pendingRuleNudge = { rule };
			ctx.abort("system");
		}
	});

	pi.on("message_end", (event) => {
		if (genState.userCancelled) return undefined;
		if (event.message.role !== "assistant") return undefined;
		const turnText = collectAssistantText(event.message);
		if (repetitiveTurns.armed) {
			repetitiveTurns.commitArmedTurn(turnText);
			manager?.markInjectedByNames([REPETITIVE_TURNS_RULE_NAME]);
			recordInjection(REPETITIVE_TURNS_RULE_NAME, [REPETITIVE_TURNS_RULE_NAME], "nudge");
			pendingNudge = buildNudgeMessage(REPETITIVE_TURNS_RULE_NAME, REPETITIVE_TURNS_RULE_CONTENT);
			return undefined;
		}
		if (pendingRuleNudge !== null) {
			const pending = pendingRuleNudge;
			pendingRuleNudge = null;
			manager?.markInjectedByNames([pending.rule.name]);
			recordInjection(pending.rule.name, [pending.rule.name], "nudge");
			pendingNudge = buildNudgeMessage(pending.rule.name, pending.rule.content);
			return undefined;
		}
		if (pendingRemediation !== null) {
			if (turnText !== null) repetitiveTurns.recordCompletedTurn(turnText);
			const pending = pendingRemediation;
			pendingRemediation = null;
			try {
				const outcome = buildStreamRemediation(pending, event.message);
				recordInjection(outcome.owner, outcome.observedRules, outcome.retryMode);
				if (outcome.nudge !== null) {
					pendingNudge = outcome.nudge;
				}
				const merged = { ...event.message, ...outcome.replacement };
				return { message: merged as unknown as typeof event.message };
			} catch (error) {
				pi.appendEntry("ttsr-remediation-error", {
					message: error instanceof Error ? error.message : String(error),
					at: Date.now(),
				});
				return undefined;
			}
		}
		if (turnText !== null) repetitiveTurns.recordCompletedTurn(turnText);
		return undefined;
	});

	pi.on("agent_settled", () => {
		if (pendingNudge === null || genState.userCancelled || settlingAgentEnd?.abortSource === "user") {
			pendingNudge = null;
			settlingAgentEnd = null;
			return;
		}
		const nudge = pendingNudge;
		pendingNudge = null;
		pi.sendMessage(nudge, { triggerTurn: true });
	});
}
