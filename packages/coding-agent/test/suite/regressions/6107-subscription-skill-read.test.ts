import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import { applyStreamEvent } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-events.ts";
import {
	emptyOutput,
	type StreamBlock,
} from "../../../src/core/extensions/builtin/anthropic-subscription/stream-protocol.ts";
import { mapToolArgs } from "../../../src/core/extensions/builtin/anthropic-subscription/tools.ts";
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "../../../src/core/skills.ts";
import { runInstalledSdkLocalTurn } from "../../helpers/anthropic-subscription-local-probe.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// #6107 / #3799: the model's advertised location must reach the selected file through
// the normal host read pipeline, without revealing the agent directory or selecting
// a same-named skill from Claude's directory.
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.unstubAllEnvs();
});

function advertisedPaths(prompt: string): string[] {
	const roots = new Map([...prompt.matchAll(/<(r\d+)>([^<]+)<\/\1>/g)].map((m) => [m[1], m[2]]));
	const expand = (location: string): string => {
		const [alias, ...parts] = location.split("/");
		const root = roots.get(alias);
		return root === undefined ? location : `${root}/${parts.join("/")}`;
	};
	const xml = [...prompt.matchAll(/<location>([^<]+)<\/location>/g)].map((m) => expand(m[1]));
	if (xml.length) return xml;
	return [...prompt.matchAll(/^- (\S+) \[([^\]]+)\]/gm)].map((m) =>
		expand(m[2].includes("/") ? m[2] : `${m[2]}/${m[1]}/SKILL.md`),
	);
}

function appendFor(harness: Harness, skills: Skill[], shape: string): string {
	const catalog =
		shape === "legacy"
			? [
					"The following skills provide specialized instructions for specific tasks.",
					"<available_skills>",
					...skills.map((skill) => `<skill><location>${skill.filePath}</location></skill>`),
					"</available_skills>",
				].join("\n")
			: formatSkillsForPrompt(
					shape === "compact"
						? skills.map((skill) => ({ ...skill, description: "Use when needed. ".repeat(600) }))
						: skills,
				);
	const options = buildAnthropicSubscriptionQueryOptions({
		model: harness.getModel(),
		cwd: harness.tempDir,
		sessionId: harness.sessionManager.getSessionId(),
		context: { messages: [], systemPrompt: catalog },
		providerSettings: { systemPromptMode: "preset-append" },
	});
	if (typeof options.systemPrompt !== "object" || !("append" in options.systemPrompt)) {
		throw new Error("Expected the preset append");
	}
	return options.systemPrompt.append ?? "";
}

async function fixture(competing: boolean, deny = false) {
	const root = mkdtempSync(join(tmpdir(), "senpi-6107-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "private-&-agent");
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
	const roots = [join(agentDir, "skills"), join(agentDir, "skills", "team")];
	const skills = roots.flatMap((dir, index) => {
		const file = join(dir, "duplicate", "SKILL.md");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `---\nname: duplicate\ndescription: Use this fixture.\n---\nSELECTED_${index}\n`);
		return loadSkillsFromDir({ dir: dirname(file), source: "user" }).skills;
	});
	if (competing) {
		const stale = join(root, "home", ".claude", "skills", "duplicate");
		mkdirSync(stale, { recursive: true });
		writeFileSync(join(stale, "SKILL.md"), "WRONG_CLAUDE_COPY\n");
	}
	const checked: string[] = [];
	const preflight: unknown[] = [];
	const extensionsResult = await createTestExtensionsResult([
		{
			path: "<fixture:skill-policy>",
			factory: (pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "read") preflight.push(event.input.path);
				});
				pi.registerFilesystemPolicy({
					check(request) {
						checked.push(request.canonicalPath);
						return deny ? { allow: false, reason: "fixture skill read denied" } : { allow: true };
					},
				});
			},
		},
	]);
	const resourceLoader = {
		...createTestResourceLoader({ extensionsResult }),
		getSkills: () => ({ skills, diagnostics: [] }),
	};
	const harness = await createHarness({ resourceLoader, initialActiveToolNames: ["read"] });
	cleanups.push(harness.cleanup);
	return { root, agentDir, skills, harness, checked, preflight, resourceLoader };
}

async function readPaths(harness: Harness, paths: string[]) {
	harness.setResponses([
		fauxAssistantMessage(
			paths.map((path, index) => {
				const mapped = mapToolArgs("Read", { file_path: path });
				if (typeof mapped.path !== "string") throw new Error("Read did not map file_path");
				return {
					type: "toolCall",
					id: `read-${index}`,
					name: "read",
					arguments: { path: mapped.path },
				};
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Read the advertised skill files.");
	return harness.session.messages.filter((message) => message.role === "toolResult");
}

describe("subscription skill locations reach only this session's loaded copies", () => {
	it.each([
		["XML roots", "xml", false],
		["XML roots with competing copy", "xml", true],
		["compact roots", "compact", false],
		["compact roots with competing copy", "compact", true],
		["legacy locations", "legacy", false],
		["legacy locations with competing copy", "legacy", true],
	] as const)("%s remain opaque and read both duplicate names", async (_label, shape, competing) => {
		const { agentDir, skills, harness, checked, preflight } = await fixture(competing);
		const append = appendFor(harness, skills, shape);
		const paths = advertisedPaths(append);
		expect(append).not.toContain(agentDir);
		expect(paths).toHaveLength(2);
		expect(new Set(paths).size).toBe(2);

		const results = await readPaths(harness, paths);

		expect(results.map(getMessageText)).toEqual(skills.map((skill) => readFileSync(skill.filePath, "utf8")));
		expect(results.map((result) => result.isError)).toEqual([false, false]);
		expect(preflight).toEqual(skills.map((skill) => skill.filePath));
		expect(checked).toEqual(skills.map((skill) => skill.filePath));
		const call = harness.session.messages.find((message) => message.role === "assistant");
		expect(JSON.stringify(call)).not.toContain(agentDir);
	});

	it("authorizes the real selected file and preserves a denied read", async () => {
		const { harness, skills, checked } = await fixture(true, true);
		const paths = advertisedPaths(appendFor(harness, skills, "xml"));
		const results = await readPaths(harness, paths.slice(0, 1));
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(getMessageText(results[0])).toContain("fixture skill read denied");
		expect(checked).toEqual([skills[0].filePath]);
	});

	it("executes an installed SDK Read through the production stream adapter and host read", async () => {
		const { harness, skills } = await fixture(true);
		const [path] = advertisedPaths(appendFor(harness, skills, "xml"));
		const model = harness.getModel();
		const output = emptyOutput(model);
		const blocks: StreamBlock[] = [];
		const stream = createAssistantMessageEventStream();
		const observation = await runInstalledSdkLocalTurn("Read", { file_path: path }, (message) => {
			if (message.type === "stream_event") {
				applyStreamEvent({ model, output, blocks, stream, customToolNameToPi: new Map() }, message.event);
			}
		});
		expect(observation.terminalReason).toBe("hook_stopped");
		expect(observation.executedToolResults).toBe(0);
		harness.setResponses([output, fauxAssistantMessage("done")]);

		await harness.session.prompt("Read the advertised skill.");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map(getMessageText)).toEqual([readFileSync(skills[0].filePath, "utf8")]);
		expect(results[0].isError).toBe(false);
	});

	it("does not resolve another session's aliases or arbitrary paths under a displayed root", async () => {
		const { harness, skills, resourceLoader } = await fixture(false);
		writeFileSync(join(dirname(skills[0].filePath), "unadvertised.md"), "UNADVERTISED_FILE\n");
		writeFileSync(join(dirname(dirname(skills[0].filePath)), "outside"), "TRAVERSAL_TARGET\n");
		const paths = advertisedPaths(appendFor(harness, skills, "xml"));
		const sibling = await createHarness({ resourceLoader, initialActiveToolNames: ["read"] });
		cleanups.push(sibling.cleanup);
		const siblingPaths = advertisedPaths(appendFor(sibling, skills, "xml"));
		expect(siblingPaths).not.toEqual(paths);
		const results = await readPaths(sibling, [
			paths[0],
			siblingPaths[0].replace(/SKILL\.md$/, "unadvertised.md"),
			`${siblingPaths[0]}/../../outside`,
		]);
		expect(results.map((result) => result.isError)).toEqual([true, true, true]);
	});
});
