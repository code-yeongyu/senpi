import type { Skill } from "../skills.ts";
import { formatSkillsForPrompt } from "../skills.ts";
import { buildExplorationSection } from "./exploration.ts";
import { buildIdentitySection } from "./identity.ts";
import { buildIntentGate } from "./intent-gate.ts";
import { buildParallelToolsSection } from "./parallel-tools.ts";
import { buildPoliciesSection } from "./policies.ts";
import { buildStyleSection } from "./style.ts";
import { categorizeTools } from "./tool-categorization.ts";
import { buildToolSection } from "./tool-section.ts";
import type { AvailableTool } from "./types.ts";
import { buildVerificationSection } from "./verification.ts";

/** Context handed to a `corePrompt` override so it can reuse the dynamic pieces. */
export interface DynamicPromptCoreContext {
	tools: AvailableTool[];
	/** Rendered "## Available Tools" (+ "## Tool Guidelines") section. */
	toolSection: string;
}

export interface BuildDynamicSystemPromptOptions {
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
	 * date, and cwd assembly stay in this builder.
	 */
	corePrompt?: (context: DynamicPromptCoreContext) => string;
}

function buildContextFilesSection(contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) {
		return "";
	}

	const lines = ["## Project Context", ""];
	for (const contextFile of contextFiles) {
		lines.push(`### ${contextFile.path}`, "", contextFile.content.trimEnd(), "");
	}
	return lines.join("\n").trimEnd();
}

export function buildDynamicSystemPrompt(options: BuildDynamicSystemPromptOptions): string {
	const promptCwd = options.cwd.replace(/\\/g, "/");
	const tools = categorizeTools(options.selectedTools);
	const date = new Date().toISOString().slice(0, 10);

	const toolSection = buildToolSection({
		tools,
		toolSnippets: options.toolSnippets,
		promptGuidelines: options.promptGuidelines,
	});

	const sections = options.corePrompt
		? [options.corePrompt({ tools, toolSection })]
		: [
				buildIdentitySection(),
				"",
				buildIntentGate({ tools }),
				"",
				buildParallelToolsSection(),
				"",
				buildExplorationSection(),
				"",
				buildVerificationSection(),
				"",
				toolSection,
				"",
				buildPoliciesSection(),
				"",
				buildStyleSection(),
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

	sections.push("", `Current date: ${date}`, `Current working directory: ${promptCwd}`);

	return sections.join("\n");
}
