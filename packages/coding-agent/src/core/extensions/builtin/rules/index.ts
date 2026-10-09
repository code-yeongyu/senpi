import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionHandler,
} from "../../types.ts";

import { appendRuleActivation, registerRuleActivationRenderer } from "../rule-activation/index.ts";
import { registerSlashCommands } from "./commands.ts";
import { configFromEnvironment } from "./config.ts";
import { createEngine } from "./rules/engine.ts";
import { findRuleCandidates } from "./rules/finder.ts";
import { findProjectRoot } from "./rules/project-root.ts";
import { extractToolPaths } from "./rules/tool-paths.ts";
import type { PiRulesConfig } from "./rules/types.ts";

type PiRulesMode = PiRulesConfig["mode"];

const MODE_VALUES = new Set<string>(["static", "dynamic", "both", "off"]);
const DYNAMIC_CONTEXT_SCOPE = "live-context";

export default function piRulesExtension(pi: ExtensionAPI): void {
	pi.registerFlag("pi-rules-disabled", {
		type: "boolean",
		default: false,
		description: "Disable pi-rules hooks.",
	});
	pi.registerFlag("pi-rules-mode", {
		type: "string",
		default: "both",
		description: "Rule injection mode: static, dynamic, both, or off.",
	});
	const config = configFromEnvironment();
	const envDisabled = config.disabled;
	const engine = createEngine(config, {
		findCandidates: findRuleCandidates,
		readFile: (path) => {
			try {
				return readFileSync(path, "utf-8");
			} catch {
				return null;
			}
		},
		findProjectRoot,
		extractToolPaths,
	});
	registerSlashCommands(pi, engine);
	registerRuleActivationRenderer(pi);

	/**
	 * Absolute paths (and realpaths) of context files pi loaded natively into the system
	 * prompt. Rebuilt on every before_agent_start. Dynamic discovery walks to the repository
	 * root, so single-file rules (AGENTS.md/CLAUDE.md) from levels the agent has natively
	 * loaded must be deduplicated in the tool_result path as well — otherwise each matching
	 * read re-injects a context file that is already in the system prompt.
	 */
	const nativeContextPaths = new Set<string>();

	function syncConfigFromFlags(): void {
		const disabled = pi.getFlag("pi-rules-disabled");
		const mode = pi.getFlag("pi-rules-mode");

		if (typeof disabled === "boolean") {
			engine.config.disabled = disabled || envDisabled;
		}
		if (typeof mode === "string" && isPiRulesMode(mode)) {
			engine.config.mode = mode;
		}
	}

	pi.on("session_start", async (event, ctx) => {
		syncConfigFromFlags();
		engine.resetSession(ctx.cwd);
		if (engine.config.disabled) {
			return undefined;
		}

		pi.appendEntry("pi-rules.scan", { cwd: ctx.cwd, reason: event.reason });
		return undefined;
	});

	pi.on("session_compact", async (event, ctx) => {
		// Rejected compactions do not mutate session state; do not reset rules.
		if (!event.accepted) return undefined;
		engine.resetSession(ctx.cwd);
		pi.appendEntry("pi-rules.scan", { cwd: ctx.cwd, reason: "compact" });
		return undefined;
	});

	const onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> = async (
		event,
		ctx,
	) => {
		syncConfigFromFlags();
		if (engine.config.disabled || engine.config.mode === "off" || engine.config.mode === "dynamic") {
			return undefined;
		}

		const loaded = engine.loadStaticRules(ctx.cwd);
		// A preview composes the same block but leaves the injection marks the dynamic
		// tool_result path reads untouched: no turn follows it.
		const commit = event.preview !== true;
		const contextPaths = commit ? nativeContextPaths : new Set<string>();
		contextPaths.clear();
		for (const path of event.systemPromptOptions.contextFiles?.flatMap((contextFile) => pathKeys(contextFile.path)) ??
			[]) {
			contextPaths.add(path);
		}
		for (const rule of loaded.rules) {
			if (commit && (contextPaths.has(rule.path) || contextPaths.has(rule.realPath))) {
				engine.markStaticInjected(rule);
			}
		}
		// Deliberately NOT gated on isStaticInjected: the host re-emits this from the BASE prompt
		// every user prompt, so a prior turn's mark would drop the block from turn 2 onward. The
		// marks below serve only the dynamic tool_result path.
		const rules = loaded.rules.filter((rule) => !contextPaths.has(rule.path) && !contextPaths.has(rule.realPath));

		if (rules.length === 0) {
			return undefined;
		}

		const block = engine.formatStatic(rules);
		if (commit) {
			for (const rule of rules) {
				engine.markStaticInjected(rule);
			}
		}

		return { systemPrompt: event.systemPrompt + block };
	};
	pi.on("before_agent_start", onBeforeAgentStart, { previewSafe: true });

	pi.on("tool_result", async (event, ctx) => {
		syncConfigFromFlags();
		if (engine.config.disabled || engine.config.mode === "off" || engine.config.mode === "static" || event.isError) {
			return undefined;
		}

		const targetPaths = extractToolPaths(event, ctx.cwd);
		const firstTargetPath = targetPaths[0];
		if (firstTargetPath === undefined) {
			return undefined;
		}

		const fingerprints = engine.fingerprintDynamicTargets(ctx.cwd, targetPaths);
		const pendingFingerprints = fingerprints.filter((target) => !engine.isDynamicTargetFingerprintCurrent(target));
		if (pendingFingerprints.length === 0) {
			engine.commitDynamicTargetFingerprints(fingerprints);
			return undefined;
		}

		const loaded = engine.loadDynamicRules(
			ctx.cwd,
			pendingFingerprints.map((target) => target.targetPath),
		);
		engine.commitDynamicTargetFingerprints(fingerprints);
		for (const rule of loaded.rules) {
			if (nativeContextPaths.has(rule.path) || nativeContextPaths.has(rule.realPath)) {
				engine.markStaticInjected(rule);
			}
		}
		// DYNAMIC_CONTEXT_SCOPE already dedups every rule (single-file or glob) session-wide, which
		// subsumes upstream's per-session single-file set.
		const rules = loaded.rules.filter(
			(rule) =>
				!nativeContextPaths.has(rule.path) &&
				!nativeContextPaths.has(rule.realPath) &&
				!engine.isStaticInjected(rule) &&
				!engine.isDynamicInjected(DYNAMIC_CONTEXT_SCOPE, rule),
		);
		if (rules.length === 0) {
			return undefined;
		}

		const firstPendingTarget = pendingFingerprints[0]?.targetPath ?? firstTargetPath;
		const targetPath = displayPath(ctx.cwd, firstPendingTarget);
		const block = engine.formatDynamic(rules, targetPath);
		for (const rule of rules) {
			engine.markDynamicInjected(DYNAMIC_CONTEXT_SCOPE, rule);
		}
		appendRuleActivation(pi, {
			kind: "project-rules",
			targetPath,
			rules: rules.map((rule) => rule.relativePath),
			toolCallId: event.toolCallId,
		});

		return { content: [...event.content, { type: "text", text: block, audience: "model" }] };
	});
}

function isPiRulesMode(value: string): value is PiRulesMode {
	return MODE_VALUES.has(value);
}

function pathKeys(filePath: string): string[] {
	try {
		return [filePath, realpathSync.native(filePath)];
	} catch {
		return [filePath];
	}
}

function displayPath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
}
