import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionEvent,
	parseSkillBlock,
	parseSkillInvocationTokens,
} from "../../../src/core/agent-session.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import type { ResourceLoader } from "../../../src/index.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

type SkillFixture = { name: string; body: string; filePath: string };

const knownSkillNames = new Set(["debugging", "frontend"]);

const skillBlock = (skill: SkillFixture, baseDir: string): string =>
	`The user explicitly invoked the "${skill.name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${baseDir}.\n\n${skill.body}\n</skill-instruction>`;

const userRequest = (request: string): string => `<user-request>\n${request}\n</user-request>`;

function createSkillFixtures(
	tempDir: string,
	definitions: readonly { name: string; body: string }[],
): { resourceLoader: ResourceLoader; skills: SkillFixture[] } {
	const skills = definitions.map((definition) => {
		const filePath = join(tempDir, `${definition.name}.md`);
		writeFileSync(filePath, definition.body);
		return { ...definition, filePath };
	});
	return {
		skills,
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

describe("#1778 inline skill mentions", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createFixtures(definitions: readonly { name: string; body: string }[]) {
		const tempDir = join(tmpdir(), `pi-issue-1778-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return { ...createSkillFixtures(tempDir, definitions), tempDir };
	}

	it("tokenizes a bare inline dollar token only when it names a known skill", () => {
		expect(parseSkillInvocationTokens("fix this $debugging now", { knownSkillNames })).toEqual([
			{ name: "debugging", syntax: "dollar", start: 9, end: 19, position: "inline" },
		]);
		expect(parseSkillInvocationTokens("echo $HOME $1 $missing a$debugging", { knownSkillNames })).toEqual([]);
		expect(parseSkillInvocationTokens("fix this $debugging now")).toEqual([]);
	});

	it("keeps the explicit namespace executable next to bare inline mentions", () => {
		expect(parseSkillInvocationTokens("a $skill:debugging b $frontend", { knownSkillNames })).toEqual([
			{ name: "debugging", syntax: "dollar", start: 2, end: 18, position: "inline" },
			{ name: "frontend", syntax: "dollar", start: 21, end: 30, position: "inline" },
		]);
	});

	it("expands every inline mention on submit and reports each invoked skill", async () => {
		const { resourceLoader, skills, tempDir } = createFixtures([
			{ name: "debugging", body: "# Debugging Skill\n\nTrace the defect." },
			{ name: "frontend", body: "# Frontend Skill\n\nBuild the page." },
		]);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const events: AgentSessionEvent[] = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "skill_invocation") events.push(event);
		});

		const actual = await promptAndCapture(harness, "explain $debugging and $frontend for $HOME");
		unsubscribe();

		expect(actual).toBe(
			`${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(skills[1]!, tempDir)}\n\n${userRequest(
				"explain [skill: debugging] and [skill: frontend] for $HOME",
			)}`,
		);
		expect(events).toEqual([
			{
				type: "skill_invocation",
				skills: [
					{ name: "debugging", path: skills[0]!.filePath, syntax: "dollar" },
					{ name: "frontend", path: skills[1]!.filePath, syntax: "dollar" },
				],
			},
		]);
		expect(parseSkillBlock(actual)?.skills.map((skill) => skill.name)).toEqual(["debugging", "frontend"]);
	});

	it("parses every chained skill block for the transcript", () => {
		const { skills, tempDir } = createFixtures([
			{ name: "debugging", body: "Trace the defect." },
			{ name: "frontend", body: "Build the page." },
		]);
		const text = `${skillBlock(skills[0]!, tempDir)}\n\n${skillBlock(skills[1]!, tempDir)}\n\n${userRequest("go")}`;

		const parsed = parseSkillBlock(text);

		expect(parsed?.name).toBe("debugging");
		expect(parsed?.userMessage).toBe("go");
		expect(parsed?.skills).toEqual([
			{ name: "debugging", location: skills[0]!.filePath, content: expect.stringContaining("Trace the defect.") },
			{ name: "frontend", location: skills[1]!.filePath, content: expect.stringContaining("Build the page.") },
		]);
	});
});
