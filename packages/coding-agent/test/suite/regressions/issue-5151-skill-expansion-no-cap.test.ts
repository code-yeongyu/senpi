import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import {
	formatSkillReferenceBody,
	parseSkillBlock,
	parseSkillInvocationTokens,
	SKILL_INLINE_BUDGET_CHARS,
} from "../../../src/core/skill-invocation.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";
import {
	createSkillResourceLoader,
	promptAndCapture,
	type SkillDefinition,
	type SkillFixture,
	skillBlock,
	userRequest,
} from "./308-skill-composition-support.ts";

const numberedSkills = (count: number): SkillDefinition[] =>
	Array.from({ length: count }, (_, index) => ({
		name: `skill-${index + 1}`,
		body: `# Skill ${index + 1}\n\nUse skill ${index + 1}.`,
	}));

describe("#5151 every invoked skill loads, with no per-prompt cap", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function setup(definitions: SkillDefinition[], options: Omit<HarnessOptions, "resourceLoader"> = {}) {
		const tempDir = join(tmpdir(), `pi-issue-5151-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const { resourceLoader, skills } = createSkillResourceLoader(tempDir, definitions);
		const harness = await createHarness({ ...options, resourceLoader });
		harnesses.push(harness);
		const expansionErrors: string[] = [];
		harness.getExtensionRunner().onError((error) => {
			if (error.event === "skill_expansion") expansionErrors.push(error.error);
		});
		const invocations: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "skill_invocation") invocations.push(event);
		});
		return { harness, skills, tempDir, expansionErrors, invocations };
	}

	const leading = (skills: readonly SkillFixture[]): string => skills.map((skill) => `/skill:${skill.name}`).join(" ");

	it("loads seven skills in one prompt and reports no skill_expansion error, even for a repeat", async () => {
		const { harness, skills, tempDir, expansionErrors, invocations } = await setup(numberedSkills(7));
		const first = skills.slice(0, 6);
		const seventh = skills[6]!;

		const actual = await promptAndCapture(
			harness,
			`${leading(first)} first line\nsecond line $${seventh.name} then $${skills[0]!.name} again`,
		);

		expect(actual).toBe(
			`${skills.map((skill) => skillBlock(skill, tempDir)).join("\n\n")}\n\n${userRequest(
				`first line\nsecond line [skill: ${seventh.name}] then [skill: ${skills[0]!.name}] again`,
			)}`,
		);
		expect(expansionErrors).toEqual([]);
		expect(invocations).toEqual([
			{
				type: "skill_invocation",
				skills: skills.map((skill, index) => ({
					name: skill.name,
					path: skill.filePath,
					syntax: index < 6 ? "slash" : "dollar",
				})),
			},
		]);
	});

	it("ignores a legacy maxSkillExpansionsPerPrompt value in settings.json", async () => {
		const { harness, skills, tempDir, expansionErrors } = await setup(numberedSkills(6), {
			fileSettings: true,
			settingsContent: JSON.stringify({ maxSkillExpansionsPerPrompt: 1 }),
		});

		expect(await promptAndCapture(harness, `${leading(skills)} compose`)).toBe(
			`${skills.map((skill) => skillBlock(skill, tempDir)).join("\n\n")}\n\n${userRequest("compose")}`,
		);
		expect(expansionErrors).toEqual([]);
		expect(harness.settingsManager.drainErrors()).toEqual([]);
	});

	it("inlines bodies up to the size budget and loads the rest as read references", async () => {
		const half = SKILL_INLINE_BUDGET_CHARS / 2;
		const { harness, skills, tempDir, expansionErrors, invocations } = await setup([
			{ name: "half-a", body: "a".repeat(half) },
			{ name: "half-b", body: "b".repeat(half) },
			{ name: "small", body: "# Small\n\nOne more line." },
		]);

		const actual = await promptAndCapture(harness, `${leading(skills)} compose`);

		expect(actual).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(skills[1]!, tempDir)}\n\n${skillBlock(
				skills[2]!,
				tempDir,
				formatSkillReferenceBody(skills[2]!.filePath),
			)}\n\n${userRequest("compose")}`,
		);
		expect(parseSkillBlock(actual)?.skills.map((skill) => [skill.name, skill.location])).toEqual(
			skills.map((skill) => [skill.name, skill.filePath]),
		);
		expect(parseSkillBlock(actual)?.userMessage).toBe("compose");
		expect(expansionErrors).toEqual([]);
		expect(invocations).toHaveLength(1);
	});

	it("always inlines the first skill, even one larger than the budget", async () => {
		const { harness, skills, tempDir } = await setup([
			{ name: "huge", body: "h".repeat(SKILL_INLINE_BUDGET_CHARS + 1) },
			{ name: "next", body: "# Next\n\nUse next." },
		]);

		expect(await promptAndCapture(harness, `${leading(skills)} go`)).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(
				skills[1]!,
				tempDir,
				formatSkillReferenceBody(skills[1]!.filePath),
			)}\n\n${userRequest("go")}`,
		);
	});

	it("parses every invocation token, with no token cap", () => {
		const prompt = Array.from({ length: 84 }, () => "$skill:debugging").join(" ");

		expect(parseSkillInvocationTokens(prompt)).toHaveLength(84);
	});
});
