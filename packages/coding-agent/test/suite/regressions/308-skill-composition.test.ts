import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionEvent,
	MAX_SKILL_EXPANSIONS_PER_PROMPT,
	MAX_SKILL_INVOCATION_TOKENS_PER_PROMPT,
	parseSkillInvocationTokens,
} from "../../../src/core/agent-session.ts";
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
	`The user explicitly invoked the "${skill.name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${baseDir}.\n\n${skill.body}\n</skill-instruction>`;

const userRequest = (request: string): string => `<user-request>\n${request}\n</user-request>`;

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

function collectSkillInvocationEvents(harness: Harness): {
	events: AgentSessionEvent[];
	unsubscribe: () => void;
} {
	const events: AgentSessionEvent[] = [];
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "skill_invocation") events.push(event);
	});
	return { events, unsubscribe };
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
			`${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(skills[1]!, tempDir)}\n\n${userRequest("compose both skills")}`,
		);
	});

	it("expands a leading dollar skill and emits invocation metadata", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "debugging", body: "# Debugging Skill\n\nTrace the defect." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const invocationEvents = collectSkillInvocationEvents(harness);

		const actual = await promptAndCapture(harness, "$debugging investigate regression");
		invocationEvents.unsubscribe();

		expect(actual).toBe(`${skillBlock(skills[0]!, tempDir)}\n\n${userRequest("investigate regression")}`);
		expect(invocationEvents.events).toEqual([
			{
				type: "skill_invocation",
				skills: [{ name: "debugging", path: skills[0]!.filePath, syntax: "dollar" }],
			},
		]);
	});

	it("expands explicit desktop dollar skills inline while preserving ordinary dollar prose", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "debugging", body: "# Debugging Skill\n\nTrace the defect." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const invocationEvents = collectSkillInvocationEvents(harness);

		const actual = await promptAndCapture(harness, "Use $skill:debugging to inspect $HOME safely");
		invocationEvents.unsubscribe();

		expect(actual).toBe(`${skillBlock(skills[0]!, tempDir)}\n\n${userRequest("Use to inspect $HOME safely")}`);
		expect(invocationEvents.events).toEqual([
			{
				type: "skill_invocation",
				skills: [{ name: "debugging", path: skills[0]!.filePath, syntax: "dollar" }],
			},
		]);
	});

	it("preserves indentation and blank-line structure outside removed tokens", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "first", body: "# First Skill\n\nUse the first skill." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		const actual = await promptAndCapture(harness, "/skill:first\n\n    const x = 1;\n\treturn x;");

		expect(actual).toBe(`${skillBlock(skills[0]!, tempDir)}\n\n${userRequest("    const x = 1;\n\treturn x;")}`);
	});

	it("bounds token parsing before processing adversarial repeated input", () => {
		const prompt = Array.from({ length: MAX_SKILL_INVOCATION_TOKENS_PER_PROMPT + 20 }, () => "$skill:debugging").join(
			" ",
		);

		const tokens = parseSkillInvocationTokens(prompt);

		expect(tokens).toHaveLength(MAX_SKILL_INVOCATION_TOKENS_PER_PROMPT);
		expect(prompt.slice(tokens.at(-1)!.end)).toContain("$skill:debugging");
	});

	it("keeps bare inline dollar skill names literal", async () => {
		const { resourceLoader } = createFixtures([
			{ name: "debugging", body: "# Debugging Skill\n\nTrace the defect." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const invocationEvents = collectSkillInvocationEvents(harness);
		const prompt = "Use $debugging now";

		expect(await promptAndCapture(harness, prompt)).toBe(prompt);
		invocationEvents.unsubscribe();
		expect(invocationEvents.events).toEqual([]);
	});

	it("preserves mixed dollar and slash invocation order", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "debugging", body: "# Debugging Skill\n\nTrace the defect." },
			{ name: "review", body: "# Review Skill\n\nReview the result." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const invocationEvents = collectSkillInvocationEvents(harness);

		const actual = await promptAndCapture(harness, "$debugging /skill:review compare them");
		invocationEvents.unsubscribe();

		expect(actual).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(skills[1]!, tempDir)}\n\n${userRequest("compare them")}`,
		);
		expect(invocationEvents.events).toEqual([
			{
				type: "skill_invocation",
				skills: [
					{ name: "debugging", path: skills[0]!.filePath, syntax: "dollar" },
					{ name: "review", path: skills[1]!.filePath, syntax: "slash" },
				],
			},
		]);
	});

	it("stops at an unknown skill without swallowing it or later text", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "first", body: "# First Skill\n\nUse the first skill." },
			{ name: "second", body: "# Second Skill\n\nUse the second skill." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		expect(await promptAndCapture(harness, "/skill:first /skill:missing /skill:second keep this literal")).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\n${userRequest("/skill:missing /skill:second keep this literal")}`,
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
			`${skillBlock(skills[0]!, tempDir)}\n\n${userRequest("compose once")}`,
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
				.join("\n\n")}\n\n${userRequest(
				`/skill:${skills[MAX_SKILL_EXPANSIONS_PER_PROMPT]!.name} /skill:${skills[MAX_SKILL_EXPANSIONS_PER_PROMPT + 1]!.name} compose within the cap`,
			)}`,
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
			`${expandedSkills}\n\n${userRequest("steer this")}`,
			`${expandedSkills}\n\n${userRequest("follow this")}`,
		]);
	});
});
