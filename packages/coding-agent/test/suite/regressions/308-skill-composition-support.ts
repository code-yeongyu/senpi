import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PromptOptions } from "../../../src/core/agent-session.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import type { ResourceLoader } from "../../../src/index.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { getMessageText, type Harness } from "../harness.ts";

export type SkillDefinition = {
	name: string;
	body: string;
};

export type SkillFixture = SkillDefinition & {
	filePath: string;
};

export const skillBlock = (skill: SkillFixture, baseDir: string, body: string = skill.body): string =>
	`The user explicitly invoked the "${skill.name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill-instruction>`;

export const userRequest = (request: string): string => `<user-request>\n${request}\n</user-request>`;

export function createSkillResourceLoader(
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

export async function promptAndCapture(harness: Harness, text: string, options?: PromptOptions): Promise<string> {
	let captured = "";
	harness.setResponses([
		(context) => {
			const userMessages = context.messages.filter((message) => message.role === "user");
			const user = userMessages[userMessages.length - 1];
			captured = user ? getMessageText(user) : "";
			return fauxAssistantMessage("ok");
		},
	]);

	await harness.session.prompt(text, options);
	return captured;
}
