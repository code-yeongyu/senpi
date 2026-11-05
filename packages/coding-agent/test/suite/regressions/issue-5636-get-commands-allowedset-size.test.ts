import { describe, expect, it } from "vitest";
import type { SkillAllowedSet } from "../../../src/core/skill-access.ts";
import type { Skill } from "../../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { serializeJsonLine } from "../../../src/modes/rpc/jsonl.ts";
import { buildRpcCommandsForSession } from "../../../src/modes/rpc/rpc-command-surface.ts";

// senpi#5636: a host with 112 commands answered get_commands with ~1.49 MB because every skill row
// carried the shared skill-read allowlist (`allowedSet`), crossing the relay's 1 MiB line limit.
const ONE_MIB = 1024 * 1024;
const SKILL_COUNT = 100;
const EXTENSION_COMMAND_COUNT = 12;

const allowedSet: SkillAllowedSet = {
	roots: Array.from({ length: 8 }, (_, i) => `/home/user/.senpi/agent/skills-root-${i}`),
	files: Array.from(
		{ length: 160 },
		(_, i) => `/home/user/.senpi/agent/skills-root-${i % 8}/skill-number-${i}/references/supporting-file-${i}.md`,
	),
	digest: "a".repeat(64),
};

function skill(index: number): Skill {
	const filePath = `/home/user/.senpi/agent/skills-root-${index % 8}/skill-${index}/SKILL.md`;
	const baseDir = `/home/user/.senpi/agent/skills-root-${index % 8}/skill-${index}`;
	return {
		name: `skill-${index}`,
		description: `Skill number ${index} for the get_commands size regression`,
		filePath,
		baseDir,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "user", baseDir }),
		disableModelInvocation: false,
		argumentHint: "<target>",
		requiresArguments: true,
		provenance: { kind: "user", selectedRoot: `/home/user/.senpi/agent/skills-root-${index % 8}` },
		allowedSet,
	};
}

const skills = Array.from({ length: SKILL_COUNT }, (_, i) => skill(i));
const session = {
	extensionRunner: {
		getRegisteredCommands: () =>
			Array.from({ length: EXTENSION_COMMAND_COUNT }, (_, i) => ({
				invocationName: `ext-${i}`,
				description: `Extension command ${i}`,
				sourceInfo: createSyntheticSourceInfo(`/home/user/.senpi/agent/extensions/ext-${i}.ts`, {
					source: "local",
				}),
			})),
	},
	promptTemplates: [],
	resourceLoader: { getSkills: () => ({ skills }) },
};

function replyLine(commands: unknown): string {
	return serializeJsonLine({ id: "1", type: "response", command: "get_commands", success: true, data: { commands } });
}

describe("get_commands reply size (senpi#5636)", () => {
	it("keeps the reply line under 1 MiB and under a tenth of the inline-allowedSet size", () => {
		const commands = buildRpcCommandsForSession(session);
		expect(commands).toHaveLength(SKILL_COUNT + EXTENSION_COMMAND_COUNT);

		const inlineLine = replyLine(
			commands.map((command, i) => (i < EXTENSION_COMMAND_COUNT ? command : { ...command, allowedSet })),
		);
		const line = replyLine(commands);

		expect(inlineLine.length).toBeGreaterThan(ONE_MIB);
		expect(line.length).toBeLessThan(ONE_MIB);
		expect(line.length).toBeLessThan(inlineLine.length / 10);
	});

	it("keeps every other skill row field and leaves the loaded skill's allowedSet in place", () => {
		const commands = buildRpcCommandsForSession(session);
		const row = commands[EXTENSION_COMMAND_COUNT];
		const { allowedSet: _internal, ...rest } = skills[0];

		expect(row).not.toHaveProperty("allowedSet");
		expect(row).toEqual({ ...rest, name: "skill:skill-0", source: "skill", syntax: "dollar" });
		expect(skills[0].allowedSet).toBe(allowedSet);
	});
});
