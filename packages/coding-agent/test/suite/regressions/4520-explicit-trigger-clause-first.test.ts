import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "../../../src/core/skills.ts";

// Regression for code-yeongyu/senpi#4520: a one-line description keeps the description's explicit when-to-use
// sentence even when imperative prose shaped like the generic verb form ("Run ... for ...") comes before it.
const FILLER =
	"Runs the release train end to end across the packages, the changelog audit, the tag, the publish workflow and the binary builds.";

function skill(name: string, description: string): Skill {
	const filePath = `/home/u/.agents/skills/${name}/SKILL.md`;
	return {
		name,
		description,
		filePath,
		baseDir: `/home/u/.agents/skills/${name}`,
		sourceInfo: { path: filePath, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
		requiresArguments: false,
	} as Skill;
}

function oneLine(description: string): string {
	const catalog = [
		...Array.from({ length: 101 }, (_, index) => skill(`skill-${index}`, FILLER)),
		skill("target", description),
	];
	const line = formatSkillsForPrompt(catalog)
		.split("\n")
		.find((entry) => entry.startsWith("- target "));
	return (line?.slice(line.indexOf("]: ") + 3) ?? "").replaceAll("&apos;", "'");
}

const LEAD =
	"Formats the release notes for every package in the monorepo, grouping entries by section and linking pull requests.";

describe("regression senpi#4520: an explicit trigger phrase wins over imperative prose", () => {
	const cases: ReadonlyArray<{ readonly shape: string; readonly description: string; readonly clause: string }> = [
		{
			shape: "issue repro: Run ... for ... before, then Use when",
			description: `${LEAD} Run the formatter for each package before tagging. Use when the user asks to draft or fix release notes.`,
			clause: "Use when the user asks to draft or fix release notes.",
		},
		{
			shape: "Load ... before decoy, then Use for",
			description: `${LEAD} Load the section template before writing any entry. Use for any release-notes question.`,
			clause: "Use for any release-notes question.",
		},
		{
			shape: "Call ... if decoy, then Use whenever",
			description: `${LEAD} Call the changelog audit if a section is empty. Use whenever someone says release notes.`,
			clause: "Use whenever someone says release notes.",
		},
		{
			shape: "Run ... decoy, then MUST USE",
			description: `${LEAD} Run the link checker after every edit. MUST USE when the user mentions release notes.`,
			clause: "MUST USE when the user mentions release notes.",
		},
		{
			shape: "Read ... decoy, then USE ONLY WHEN",
			description: `${LEAD} Read the previous notes for wording only. USE ONLY WHEN YOU ARE THE RELEASE HARNESS.`,
			clause: "USE ONLY WHEN YOU ARE THE RELEASE HARNESS.",
		},
		{
			shape: "Apply ... decoy, then This skill should be used",
			description: `${LEAD} Apply the house style when a bullet is long. This skill should be used when notes need a rewrite.`,
			clause: "This skill should be used when notes need a rewrite.",
		},
		{
			shape: "Invoke ... decoy, then Triggers:",
			description: `${LEAD} Invoke the formatter for each package. Triggers: 'release notes', 'changelog draft'.`,
			clause: "Triggers: 'release notes', 'changelog draft'.",
		},
		{
			shape: "no explicit phrase: the verb form is still the fallback",
			description: `${LEAD} ${LEAD} Read before tagging a release or editing a package changelog.`,
			clause: "Read before tagging a release or editing a package changelog.",
		},
	];

	it.each(cases)("keeps the real when-to-use sentence: $shape", ({ description, clause }) => {
		const text = oneLine(description);

		expect(text.length).toBeLessThanOrEqual(160);
		expect(text).toContain(clause);
	});
});
