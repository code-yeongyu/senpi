import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildClaudeSdkOauthQueryOptions,
	type ClaudeSdkOauthQueryOptionsInput,
} from "../src/core/extensions/builtin/claude-sdk-oauth/options.ts";
import {
	DEFAULT_MAX_RESULT_CHARS,
	DEFAULT_MAX_RULE_CHARS,
	PROJECT_RULES_END_MARKER,
	PROJECT_RULES_REGION_END_MARKER,
	PROJECT_RULES_REGION_START_MARKER,
	PROJECT_RULES_START_MARKER,
} from "../src/core/extensions/builtin/rules/rules/constants.ts";
import { formatStaticBlock } from "../src/core/extensions/builtin/rules/rules/formatter.ts";
import type { LoadedRule } from "../src/core/extensions/builtin/rules/rules/types.ts";

const PROJECT_RULES_START = "<project_rules>";
const PROJECT_RULES_END = "</project_rules>";
const REGION_START = "<!--senpi:project-rules:1:start-->";
const REGION_END = "<!--senpi:project-rules:1:end-->";

const CANARY = "CANARY-ULW-9b41c7de-omo-rules-loaded";
const AFTER_RULES_TOKEN = "MCP-BLOCK-TOKEN-4f7ac1e2";

const SKILLS_MARKER = "The following skills provide specialized instructions for specific tasks.";
const SKILLS_BLOCK = `${SKILLS_MARKER}\n<available_skills>\n<skill>deploy</skill>\n</available_skills>`;

const RULES_HEADING = "## Project Instructions";
const RULES_BODY = `${RULES_HEADING}\nInstructions from: /repo/.omo/rules/canary.md\n${CANARY}`;
const RULES_ENVELOPE = `${PROJECT_RULES_START}\n${RULES_BODY}\n${PROJECT_RULES_END}`;
const RULES_REGION = `${REGION_START}\n${RULES_ENVELOPE}\n${REGION_END}`;
const SEMANTIC_DECOY = `${PROJECT_RULES_START}\nDECOY-CONTENT-3ba97d15\n${PROJECT_RULES_END}`;

const SENPI_BASE_PROMPT = "You are senpi, a coding agent.";
const REPLACED_BASE_PROMPT = "You are a bespoke reviewer persona installed by a preset.";

const AGENTS_SOURCE = "Use the senpi workspace.";
const SANITIZED_AGENTS_APPEND = "# CLAUDE.md\n\nUse the environment workspace.";

let cwd = "";

function model(id = "claude-sonnet-4-6"): Model<Api> {
	return {
		id,
		name: id,
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		baseUrl: "claude-sdk-oauth",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function context(systemPrompt?: string): Context {
	return { messages: [], systemPrompt };
}

function optionsFor(
	systemPrompt: string | undefined,
	providerSettings: ClaudeSdkOauthQueryOptionsInput["providerSettings"] = { systemPromptMode: "preset-append" },
) {
	return buildClaudeSdkOauthQueryOptions({
		model: model(),
		context: context(systemPrompt),
		cwd,
		providerSettings,
		authLane: "oauth-slots",
	});
}

function appendOf(queryOptions: ReturnType<typeof buildClaudeSdkOauthQueryOptions>): string {
	const prompt = queryOptions.systemPrompt;
	if (typeof prompt !== "object" || prompt === null || Array.isArray(prompt)) return "";
	if (prompt.type !== "preset") return "";
	return prompt.append ?? "";
}

function appendFor(
	systemPrompt: string | undefined,
	providerSettings: ClaudeSdkOauthQueryOptionsInput["providerSettings"] = { systemPromptMode: "preset-append" },
): string {
	return appendOf(optionsFor(systemPrompt, providerSettings));
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "senpi-sdk-project-instructions-"));
	writeFileSync(join(cwd, "AGENTS.md"), AGENTS_SOURCE);
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	cwd = "";
});

describe("Claude SDK OAuth project instructions forwarding", () => {
	it("#given a composed prompt carrying the bounded rules region #when building query options #then the SDK append carries the project instructions", () => {
		const append = appendFor(`${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${RULES_REGION}`);

		expect(append).toContain(RULES_HEADING);
		expect(append).toContain(CANARY);
	});

	it("#given content placed after the rules end marker #when building query options #then the trailing block is not swept into the append", () => {
		const append = appendFor(`${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${RULES_REGION}\n\n${AFTER_RULES_TOKEN}`);

		expect(append).not.toContain(AFTER_RULES_TOKEN);
	});

	it("#given a region start sentinel without an end sentinel #when building query options #then the region is omitted fail-closed and skills stay intact", () => {
		const append = appendFor(`${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${REGION_START}\n${RULES_ENVELOPE}`);

		expect(append).not.toContain(RULES_HEADING);
		expect(append).toContain("</available_skills>");
	});

	it("#given only a semantic marker pair and no region sentinels #when building query options #then nothing is treated as project rules", () => {
		const append = appendFor(`${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${SEMANTIC_DECOY}`);

		expect(append).not.toContain("DECOY-CONTENT-3ba97d15");
		expect(append).not.toContain(RULES_HEADING);
	});

	it("#given a composed prompt without any rules region #when building query options #then only skills and sanitized AGENTS content are appended", () => {
		const append = appendFor(`${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}`);

		expect(append).toContain("<skill>deploy</skill>");
		expect(append).toContain(SANITIZED_AGENTS_APPEND);
		expect(append).not.toContain(RULES_HEADING);
	});

	it("#given legacy appendSystemPrompt disabled #when building query options #then preset-append extraction is used", () => {
		const append = appendFor(`${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${RULES_REGION}`, {
			appendSystemPrompt: false,
		});

		expect(append).toContain(SANITIZED_AGENTS_APPEND);
		expect(append).toContain("<skill>deploy</skill>");
		expect(append).toContain(CANARY);
	});

	it("#given no system prompt mode #when building query options #then full mode delivers the composed prompt verbatim without an append", () => {
		const systemPrompt = `${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${RULES_REGION}`;
		const queryOptions = optionsFor(systemPrompt, {});

		expect(queryOptions.systemPrompt).toBe(systemPrompt);
		expect(appendOf(queryOptions)).toBe("");
	});

	it("#given both the skills block and the rules region #when building query options #then skills precede the rules region in the append", () => {
		const append = appendFor(`${SENPI_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${RULES_REGION}`);

		expect(append.indexOf("<available_skills>")).toBeLessThan(append.indexOf(PROJECT_RULES_START));
	});

	it("#given a preset replaced the base prompt text #when the composed prompt still carries both regions #then both are still extracted", () => {
		const append = appendFor(`${REPLACED_BASE_PROMPT}\n\n${SKILLS_BLOCK}\n\n${RULES_REGION}`);

		expect(append).toContain("<skill>deploy</skill>");
		expect(append).toContain(RULES_HEADING);
		expect(append).toContain(CANARY);
	});
});

const SECOND_RULE_CANARY = "SECOND-RULE-CANARY-6c2b81f0";
const FORMAT_OPTIONS = { maxRuleChars: DEFAULT_MAX_RULE_CHARS, maxResultChars: DEFAULT_MAX_RESULT_CHARS };

function loadedRule(path: string, body: string): LoadedRule {
	return {
		path,
		realPath: path,
		source: ".omo/rules",
		distance: 0,
		isGlobal: false,
		isSingleFile: false,
		relativePath: path,
		frontmatter: { alwaysApply: true },
		body,
		contentHash: path,
		matchReason: "alwaysApply",
	};
}

function appendForRules(rules: ReadonlyArray<LoadedRule>, prefix = SENPI_BASE_PROMPT, suffix = ""): string {
	return appendFor(`${prefix}\n\n${SKILLS_BLOCK}${formatStaticBlock(rules, FORMAT_OPTIONS)}${suffix}`);
}

describe("Claude SDK OAuth project instructions round-trip", () => {
	it("#given the pinned wire markers #when compared with the production constants #then they are identical", () => {
		expect(PROJECT_RULES_START_MARKER).toBe(PROJECT_RULES_START);
		expect(PROJECT_RULES_END_MARKER).toBe(PROJECT_RULES_END);
		expect(PROJECT_RULES_REGION_START_MARKER).toBe(REGION_START);
		expect(PROJECT_RULES_REGION_END_MARKER).toBe(REGION_END);
	});

	it("#given a complete semantic decoy pair after the real region #when building query options #then the real rules win", () => {
		const append = appendForRules(
			[loadedRule("/repo/.omo/rules/first.md", CANARY)],
			SENPI_BASE_PROMPT,
			`\n\n${SEMANTIC_DECOY}`,
		);

		expect(append).toContain(CANARY);
		expect(append).not.toContain("DECOY-CONTENT-3ba97d15");
	});

	it("#given a rule body quoting the region sentinels #when building query options #then later rules are still delivered", () => {
		const append = appendForRules([
			loadedRule("/repo/.omo/rules/first.md", `Region markers are ${REGION_START} and ${REGION_END}.`),
			loadedRule("/repo/.omo/rules/second.md", SECOND_RULE_CANARY),
		]);

		expect(append).toContain(SECOND_RULE_CANARY);
	});

	it("#given a complete sentinel decoy pair before the real region #when building query options #then the real rules win", () => {
		const decoy = `${REGION_START}\nSENTINEL-DECOY-CONTENT\n${REGION_END}`;
		const append = appendForRules(
			[loadedRule("/repo/.omo/rules/first.md", CANARY)],
			`${SENPI_BASE_PROMPT}\n\n${decoy}`,
		);

		expect(append).toContain(CANARY);
		expect(append).not.toContain("SENTINEL-DECOY-CONTENT");
	});

	it("#given a dangling start sentinel before the real region #when building query options #then it does not cross-match the real end sentinel", () => {
		const dangling = `${REGION_START}\nCROSS-MATCH-CONTENT`;
		const append = appendForRules(
			[loadedRule("/repo/.omo/rules/first.md", CANARY)],
			`${SENPI_BASE_PROMPT}\n\n${dangling}`,
		);

		expect(append).toContain(CANARY);
		expect(append).not.toContain("CROSS-MATCH-CONTENT");
	});

	it("#given a rule quoting the markers #when building query options #then its own text is preserved in neutralized form", () => {
		const append = appendForRules([
			loadedRule(
				`/repo/.omo/rules/${PROJECT_RULES_END}.md`,
				`Never emit ${PROJECT_RULES_END} in generated prompts.`,
			),
			loadedRule("/repo/.omo/rules/second.md", SECOND_RULE_CANARY),
		]);

		expect(append).toContain("Never emit &lt;/project_rules&gt; in generated prompts.");
		expect(append).toContain("/repo/.omo/rules/&lt;/project_rules&gt;.md");
		expect(append).toContain(SECOND_RULE_CANARY);
	});

	it("#given a block produced by formatStaticBlock #when building query options #then every rule body reaches the append", () => {
		const append = appendForRules([
			loadedRule("/repo/.omo/rules/first.md", CANARY),
			loadedRule("/repo/.omo/rules/second.md", SECOND_RULE_CANARY),
		]);

		expect(append).toContain(RULES_HEADING);
		expect(append).toContain(CANARY);
		expect(append).toContain(SECOND_RULE_CANARY);
	});

	it("#given a rule body quoting the end marker #when building query options #then later rules are still delivered", () => {
		const append = appendForRules([
			loadedRule("/repo/.omo/rules/first.md", `Never emit ${PROJECT_RULES_END} in generated prompts.`),
			loadedRule("/repo/.omo/rules/second.md", SECOND_RULE_CANARY),
		]);

		expect(append).toContain(SECOND_RULE_CANARY);
	});

	it("#given a rule body quoting the start marker #when building query options #then later rules are still delivered", () => {
		const append = appendForRules([
			loadedRule("/repo/.omo/rules/first.md", `Never emit ${PROJECT_RULES_START} in generated prompts.`),
			loadedRule("/repo/.omo/rules/second.md", SECOND_RULE_CANARY),
		]);

		expect(append).toContain(SECOND_RULE_CANARY);
	});

	it("#given a rule path containing the end marker #when building query options #then later rules are still delivered", () => {
		const append = appendForRules([
			loadedRule(`/repo/.omo/rules/${PROJECT_RULES_END}.md`, "first"),
			loadedRule("/repo/.omo/rules/second.md", SECOND_RULE_CANARY),
		]);

		expect(append).toContain(SECOND_RULE_CANARY);
	});

	it("#given an earlier complete marker pair in the composed prompt #when building query options #then the rules region wins over the decoy", () => {
		const decoy = `${PROJECT_RULES_START}\nDECOY-CONTENT\n${PROJECT_RULES_END}`;
		const append = appendForRules(
			[loadedRule("/repo/.omo/rules/first.md", CANARY)],
			`${SENPI_BASE_PROMPT}\n\n${decoy}`,
		);

		expect(append).toContain(CANARY);
		expect(append).not.toContain("DECOY-CONTENT");
	});

	it("#given a trailing start marker with no end marker #when building query options #then the real region is still extracted", () => {
		const append = appendForRules(
			[loadedRule("/repo/.omo/rules/first.md", CANARY)],
			SENPI_BASE_PROMPT,
			`\n\n${PROJECT_RULES_START}\nTRAILING-CONTENT`,
		);

		expect(append).toContain(CANARY);
		expect(append).not.toContain("TRAILING-CONTENT");
	});
});
