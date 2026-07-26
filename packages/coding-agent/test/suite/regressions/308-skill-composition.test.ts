import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SKILL_EXPANSIONS_PER_PROMPT } from "../../../src/core/agent-session.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import type { ResourceLoader } from "../../../src/index.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

type SkillDefinition = {
	name: string;
	body: string;
};

type SkillFixture = SkillDefinition & {
	filePath: string;
};

const skillBlock = (skill: SkillFixture, baseDir: string): string =>
	`<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${baseDir}.\n\n${skill.body}\n</skill>`;

function createSkillResourceLoader(
	tempDir: string,
	definitions: SkillDefinition[],
): {
	resourceLoader: ResourceLoader;
	skills: SkillFixture[];
} {
	const skills = definitions.map((definition) => {
		const filePath = join(tempDir, `${definition.name}.md`);
		writeFileSync(filePath, definition.body);
		return { ...definition, filePath };
	});

	return {
		resourceLoader: {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: skills.map((skill) => ({
					name: skill.name,
					description: `${skill.name} skill`,
					filePath: skill.filePath,
					disableModelInvocation: false,
					baseDir: tempDir,
					sourceInfo: createSyntheticSourceInfo(skill.filePath, {
						source: "local",
						scope: "project",
						origin: "top-level",
						baseDir: tempDir,
					}),
				})),
				diagnostics: [],
			}),
		},
		skills,
	};
}

async function promptAndCapture(harness: Harness, text: string): Promise<string> {
	let captured = "";
	harness.setResponses([
		(context) => {
			const userMessages = context.messages.filter((message) => message.role === "user");
			const user = userMessages[userMessages.length - 1];
			captured = user ? getMessageText(user) : "";
			return fauxAssistantMessage("ok");
		},
	]);

	await harness.session.prompt(text);
	return captured;
}

async function createWaitingHarness(resourceLoader: ResourceLoader): Promise<{
	harness: Harness;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
	releaseToolExecution: () => void;
}> {
	let releaseToolExecution: () => void = () => {};
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ resourceLoader, tools: [waitTool] });
	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		waitForToolStart,
		releaseToolExecution,
		promptPromise: harness.session.prompt("start"),
	};
}

describe("#308 skill composition", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createFixtures(definitions: SkillDefinition[]): {
		resourceLoader: ResourceLoader;
		skills: SkillFixture[];
		tempDir: string;
	} {
		const tempDir = join(tmpdir(), `pi-issue-308-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return { ...createSkillResourceLoader(tempDir, definitions), tempDir };
	}

	it("expands each known skill in the leading run in written order", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "first", body: "# First Skill\n\nUse the first skill." },
			{ name: "second", body: "# Second Skill\n\nUse the second skill." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		const actual = await promptAndCapture(harness, "/skill:first /skill:second compose both skills");

		expect(actual).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(skills[1]!, tempDir)}\n\ncompose both skills`,
		);
	});

	it("stops at an unknown skill without swallowing it or later text", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "first", body: "# First Skill\n\nUse the first skill." },
			{ name: "second", body: "# Second Skill\n\nUse the second skill." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		expect(await promptAndCapture(harness, "/skill:first /skill:missing /skill:second keep this literal")).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\n/skill:missing /skill:second keep this literal`,
		);
		expect(await promptAndCapture(harness, "/skill:missing keep this literal")).toBe(
			"/skill:missing keep this literal",
		);
	});

	it("does not expand skill tokens outside the leading run", async () => {
		const { resourceLoader } = createFixtures([{ name: "first", body: "# First Skill\n\nUse the first skill." }]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const prompt = "Explain why `/skill:first` stays literal in prose.";

		expect(await promptAndCapture(harness, prompt)).toBe(prompt);
	});

	it("deduplicates a repeated leading skill while retaining the free text once", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "first", body: "# First Skill\n\nUse the first skill." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		expect(await promptAndCapture(harness, "/skill:first /skill:first compose once")).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\ncompose once`,
		);
	});

	it("caps expansion, leaves the remaining skill tokens literal, and emits a visible warning", async () => {
		const definitions = Array.from({ length: MAX_SKILL_EXPANSIONS_PER_PROMPT + 2 }, (_, index) => ({
			name: `skill-${index + 1}`,
			body: `# Skill ${index + 1}\n\nUse skill ${index + 1}.`,
		}));
		const { resourceLoader, skills, tempDir } = createFixtures(definitions);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const errors: string[] = [];
		const unsubscribe = harness.getExtensionRunner().onError((error) => {
			if (error.event === "skill_expansion") errors.push(error.error);
		});

		const prompt = `${skills.map((skill) => `/skill:${skill.name}`).join(" ")} compose within the cap`;
		const actual = await promptAndCapture(harness, prompt);
		unsubscribe();

		expect(actual).toBe(
			`${skills
				.slice(0, MAX_SKILL_EXPANSIONS_PER_PROMPT)
				.map((skill) => skillBlock(skill, tempDir))
				.join(
					"\n\n",
				)}\n\n/skill:${skills[MAX_SKILL_EXPANSIONS_PER_PROMPT]!.name} /skill:${skills[MAX_SKILL_EXPANSIONS_PER_PROMPT + 1]!.name} compose within the cap`,
		);
		expect(errors).toEqual([
			`Expanded at most ${MAX_SKILL_EXPANSIONS_PER_PROMPT} skills; remaining skill commands were left as literal text.`,
		]);
	});

	it("uses the same composed expansion for queued steering and follow-up messages", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "first", body: "# First Skill\n\nUse the first skill." },
			{ name: "second", body: "# Second Skill\n\nUse the second skill." },
		]);
		const waiting = await createWaitingHarness(resourceLoader);
		const { harness, promptPromise, releaseToolExecution, waitForToolStart } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("steering response"),
			fauxAssistantMessage("follow-up response"),
		]);

		await waitForToolStart;
		await harness.session.steer("/skill:first /skill:second steer this");
		await harness.session.followUp("/skill:first /skill:second follow this");
		releaseToolExecution();
		await promptPromise;

		const expandedSkills = `${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(skills[1]!, tempDir)}`;
		expect(getUserTexts(harness)).toEqual([
			"start",
			`${expandedSkills}\n\nsteer this`,
			`${expandedSkills}\n\nfollow this`,
		]);
	});
});
