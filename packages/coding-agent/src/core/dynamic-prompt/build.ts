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
	appName?: string;
	/** Rendered "## Available Tools" (+ "## Tool Guidelines") section. */
	toolSection: string;
}

export interface BuildDynamicSystemPromptOptions {
	/** Loader replacement and additions, assembled here with the same separators as the session. */
	customPrompt?: string;
	appendSystemPrompt?: string;
	/** Host identity; omitted preserves the Native runtime's configured brand. */
	appName?: string;
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

export interface DynamicSystemPromptPart {
	readonly name: string;
	readonly source?: string;
	/** Includes its separators: joining every text with "" is the exact provider prompt. */
	readonly text: string;
}

export function buildDynamicSystemPromptParts(options: BuildDynamicSystemPromptOptions): DynamicSystemPromptPart[] {
	if (options.customPrompt !== undefined) {
		return [
			{ name: "custom_prompt", source: "loader", text: options.customPrompt },
			...(options.appendSystemPrompt === undefined
				? []
				: [{ name: "append_system_prompt", source: "loader", text: `\n\n${options.appendSystemPrompt}` }]),
		];
	}
	const tools = categorizeTools(options.selectedTools);

	const toolSection = buildToolSection({
		tools,
		toolSnippets: options.toolSnippets,
		promptGuidelines: options.promptGuidelines,
	});

	const surface = options.surface ?? "terminal";
	const sections = options.corePrompt
		? [options.corePrompt({ tools, toolSection, surface, appName: options.appName })]
		: [
				buildIdentitySection(options.appName),
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

	const parts: DynamicSystemPromptPart[] = [{ name: "core", source: "dynamic-prompt", text: sections.join("\n") }];
	const tuning = options.tuningSection?.trim();
	if (tuning) {
		parts.push({ name: "tuning", source: "prompt-preset", text: `\n\n${tuning}` });
	}

	if (options.contextFiles.length > 0) {
		parts.push({
			name: "project_context",
			source: "dynamic-prompt",
			text: "\n\n## Project Context\n\nProject instruction files (below, and in [Directory Context: ...] blocks injected during reads) bind files under their directory; deeper files win on conflict; explicit user instructions override.\n\n",
		});
		for (const [index, file] of options.contextFiles.entries()) {
			const text = `### ${file.path}\n\n${file.content.trimEnd()}`;
			parts.push({
				name: "project_context",
				source: file.path,
				text: index === options.contextFiles.length - 1 ? text.trimEnd() : `${text}\n\n`,
			});
		}
	}

	const skillsSection = formatSkillsForPrompt(options.skills);
	if (skillsSection) {
		parts.push({ name: "skills", source: "skills", text: `\n${skillsSection}` });
	}

	parts.push({
		name: "workstation",
		source: "dynamic-prompt",
		text: `\n\n${buildWorkstationSection({
			selectedTools: options.selectedTools,
			dialect: options.workstationDialect ?? "default",
		})}`,
	});
	if (options.appendSystemPrompt !== undefined) {
		parts.push({ name: "append_system_prompt", source: "loader", text: `\n\n${options.appendSystemPrompt}` });
	}
	return parts;
}

export function buildDynamicSystemPrompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPromptParts(options)
		.map((part) => part.text)
		.join("");
}
