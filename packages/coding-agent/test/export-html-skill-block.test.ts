import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { formatSkillInvocationPrompt, type ParsedSkillBlock, parseSkillBlock } from "../src/core/agent-session.ts";

describe("export HTML skill block rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const parserSource = templateJs.match(
		/ {6}function parseSkillBlock\(text\) \{[\s\S]*?\n {6}\}\n\n {6}function getSearchableText/,
	)?.[0];
	if (!parserSource) throw new Error("Could not extract standalone export parseSkillBlock");
	const standaloneParser = runInNewContext(
		`(${parserSource.replace(/\n\n {6}function getSearchableText$/, "").replace(/^ {6}/gm, "")})`,
	) as (text: string) => ParsedSkillBlock | null;

	const skill = {
		name: "inspect",
		filePath: "/project/.agents/skills/inspect/SKILL.md",
		baseDir: "/project/.agents/skills/inspect",
		body: "# Inspect\n\nUse inspection tools.",
	};

	it("round-trips the production skill invocation payload through both parsers", () => {
		const payload = formatSkillInvocationPrompt([skill], "Check errors.");
		const expected: ParsedSkillBlock = {
			name: skill.name,
			location: skill.filePath,
			content: `References are relative to ${skill.baseDir}.\n\n${skill.body}`,
			userMessage: "Check errors.",
		};

		expect(parseSkillBlock(payload)).toEqual(expected);
		expect(standaloneParser(payload)).toEqual(expected);
	});

	it("parses chained production payloads without exposing later skill markup as the user request", () => {
		const secondSkill = {
			name: "verify",
			filePath: "/project/.agents/skills/verify/SKILL.md",
			baseDir: "/project/.agents/skills/verify",
			body: "# Verify\n\nRun focused checks.",
		};
		const payload = formatSkillInvocationPrompt([skill, secondSkill], "Check errors.");

		expect(parseSkillBlock(payload)?.userMessage).toBe("Check errors.");
		expect(standaloneParser(payload)?.userMessage).toBe("Check errors.");
	});

	it("keeps parsing legacy payloads from resumed and imported sessions", () => {
		const legacyPayload = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>\n\nCheck errors.`;
		const expected: ParsedSkillBlock = {
			name: skill.name,
			location: skill.filePath,
			content: `References are relative to ${skill.baseDir}.\n\n${skill.body}`,
			userMessage: "Check errors.",
		};

		expect(parseSkillBlock(legacyPayload)).toEqual(expected);
		expect(standaloneParser(legacyPayload)).toEqual(expected);
	});

	it("strips skill wrapper markup from user message rendering", () => {
		expect(templateJs).toMatch(/skillBlock\.userMessage/);
	});

	it("renders skill invocation and user message as separate sibling blocks", () => {
		// The skill block and user message should render as separate entry-level elements,
		// matching the TUI layout where SkillInvocationMessageComponent and
		// UserMessageComponent are siblings, not nested.
		expect(templateJs).toMatch(/skill-invocation/);

		// When a skill block has a userMessage, the user-message div must be emitted
		// as a separate block after the skill-invocation div, containing the user-authored text.
		// Verify the code checks hasUserContent so the user-message div is only omitted
		// when the skill block has no user prompt and no images.
		expect(templateJs).toMatch(/hasUserContent/);
	});

	it("renders skill content as markdown, not raw text", () => {
		// The skill block body is markdown (from the SKILL.md file).
		// It should be rendered through safeMarkedParse, not escaped as raw text.
		expect(templateJs).toMatch(/safeMarkedParse\(skillBlock\.content\)/);
	});

	it("shows skill name and user message in the sidebar tree", () => {
		// The sidebar tree should display both the skill name and the user prompt,
		// not just one or the other.
		expect(templateJs).toMatch(/tree-role-skill/);
	});
});
