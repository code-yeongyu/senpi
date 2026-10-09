import type { Skill } from "../skills.ts";
import { formatSkillsForPrompt } from "../skills.ts";
import { buildHandoffSection } from "./handoff.ts";
import { buildIdentitySection } from "./identity.ts";
import { buildIntentGate } from "./intent-gate.ts";
import { buildPoliciesSection } from "./policies.ts";
import { buildStyleSection } from "./style.ts";
import { categorizeTools } from "./tool-categorization.ts";
import { buildToolSection } from "./tool-section.ts";
import type { AvailableTool, PromptSurface } from "./types.ts";
import { buildVerificationSection } from "./verification.ts";
import { buildWorkingTaskSection } from "./working-task.ts";
import { buildWorkstationSection, type WorkstationDialect } from "./workstation.ts";

export { type PromptSurface, type TerminalOrApp, terminalOrApp } from "./types.ts";

export const PROMPT_SURFACE_ENV_VAR = "SENPI_PROMPT_SURFACE";

/** `SENPI_PROMPT_SURFACE=app` or `=chat` selects that surface; unset or any other value is the terminal. */
export function resolvePromptSurface(env: Readonly<Record<string, string | undefined>>): PromptSurface {
	const value = env[PROMPT_SURFACE_ENV_VAR];
	return value === "app" || value === "chat" ? value : "terminal";
}

/** Context handed to a `corePrompt` override so it can reuse the dynamic pieces. */
export interface DynamicPromptCoreContext {
	tools: AvailableTool[];
	surface: PromptSurface;
	/** Rendered "## Available Tools" (+ "## Tool Guidelines") section. */
	toolSection: string;
}

export interface BuildDynamicSystemPromptOptions {
	/**
	 * Session working directory. Not rendered: cwd and date reach the model as an
	 * append-only environment-context message so this prompt stays byte-stable
	 * across days and directories (senpi#2093).
	 */
	cwd: string;
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	promptGuidelines: string[];
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
	tuningSection?: string;
	/**
	 * Replaces the default core sections (identity through style) with a
	 * model-specific full rewrite. Tool section, tuning, context files, skills,
	 * and workstation assembly stay in this builder.
	 */
	corePrompt?: (context: DynamicPromptCoreContext) => string;
	/**
	 * Wording dialect for the workstation execution-context instruction.
	 * Presets pass their model family; the fallback prompt uses `default`
	 * (maximum emphasis).
	 */
	workstationDialect?: WorkstationDialect;
	/**
	 * Where replies render. `app` (a chat UI host) drops the visible routing line and keeps
	 * tool and hook feedback with the agent; `chat` (a chat bridge) also drops the handoff block and
	 * ledger lines; omitted means `terminal`.
	 */
	surface?: PromptSurface;
}

function buildContextFilesSection(contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) {
		return "";
	}

	const lines = [
		"## Project Context",
		"",
		"Project instruction files (below, and in [Directory Context: ...] blocks injected during reads) bind files under their directory; deeper files win on conflict; explicit user instructions override.",
		"",
	];
	for (const contextFile of contextFiles) {
		lines.push(`### ${contextFile.path}`, "", contextFile.content.trimEnd(), "");
	}
	return lines.join("\n").trimEnd();
}

export function buildDynamicSystemPrompt(options: BuildDynamicSystemPromptOptions): string {
	const tools = categorizeTools(options.selectedTools);

	const toolSection = buildToolSection({
		tools,
		toolSnippets: options.toolSnippets,
		promptGuidelines: options.promptGuidelines,
	});

	const surface = options.surface ?? "terminal";
	const sections = options.corePrompt
		? [options.corePrompt({ tools, toolSection, surface })]
		: [
				buildIdentitySection(),
				"",
				buildIntentGate({ tools, surface }),
				"",
				buildWorkingTaskSection(),
				"",
				buildVerificationSection({ surface }),
				"",
				toolSection,
				"",
				buildPoliciesSection(),
				"",
				buildHandoffSection({ surface }),
				"",
				buildStyleSection({ surface }),
			];

	const tuning = options.tuningSection?.trim();
	if (tuning) {
		sections.push("", tuning);
	}

	const contextFilesSection = buildContextFilesSection(options.contextFiles);
	if (contextFilesSection) {
		sections.push("", contextFilesSection);
	}

	const skillsSection = formatSkillsForPrompt(options.skills);
	if (skillsSection) {
		sections.push(skillsSection);
	}

	sections.push(
		"",
		buildWorkstationSection({
			selectedTools: options.selectedTools,
			dialect: options.workstationDialect ?? "default",
		}),
	);

	return sections.join("\n");
}
