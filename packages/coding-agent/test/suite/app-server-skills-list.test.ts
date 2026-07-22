import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import type { Skill } from "../../src/core/skills.ts";
import { createRegistry, type MethodRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { registerAppServerSkillMethods } from "../../src/modes/app-server/server/skills.ts";

const roots: string[] = [];

describe("app-server skills/list", () => {
	afterEach(async () => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps cwd order, isolates a bad cwd, and maps every Senpi skill field", async () => {
		const root = await scratchRoot();
		const validCwd = join(root, "valid");
		await mkdir(validCwd, { recursive: true });
		const missingCwd = join(root, "missing");
		const skillPaths = [
			join(validCwd, "user", "SKILL.md"),
			join(validCwd, "project", "SKILL.md"),
			join(validCwd, "temporary", "SKILL.md"),
		];
		const skills: Skill[] = [
			makeSkill("user-skill", skillPaths[0] ?? join(validCwd, "user", "SKILL.md"), "user", false),
			makeSkill("project-skill", skillPaths[1] ?? join(validCwd, "project", "SKILL.md"), "project", true),
			makeSkill("temporary-skill", skillPaths[2] ?? join(validCwd, "temporary", "SKILL.md"), "temporary", false),
		];
		const registry = createSkillsRegistry(validCwd, async () => createResourceLoader(skills));

		const response = await registry.dispatch(initializedConnection(), {
			id: 1,
			method: "skills/list",
			params: { cwds: [missingCwd, validCwd] },
		});

		expect(response).toEqual({
			id: 1,
			result: {
				data: [
					{
						cwd: resolve(missingCwd),
						skills: [],
						errors: [{ path: resolve(missingCwd), message: expect.any(String) }],
					},
					{
						cwd: resolve(validCwd),
						skills: [
							{
								name: "user-skill",
								description: "user-skill description",
								path: skillPaths[0],
								scope: "user",
								enabled: true,
							},
							{
								name: "project-skill",
								description: "project-skill description",
								path: skillPaths[1],
								scope: "repo",
								enabled: false,
							},
							{
								name: "temporary-skill",
								description: "temporary-skill description",
								path: skillPaths[2],
								scope: "system",
								enabled: true,
							},
						],
						errors: [],
					},
				],
			},
		});
	});

	it("uses the server cwd when cwds is empty and reloads a cached loader only on forceReload", async () => {
		const root = await scratchRoot();
		const loaderCwd = join(root, "cwd");
		await mkdir(loaderCwd, { recursive: true });
		let version = 1;
		let loadedVersion = 1;
		let reloadCalls = 0;
		const loader = createResourceLoader(
			() => [makeSkill(`skill-${loadedVersion}`, join(loaderCwd, "SKILL.md"), "user", false)],
			{
				reload: async () => {
					reloadCalls += 1;
					loadedVersion = version;
				},
			},
		);
		const registry = createSkillsRegistry(loaderCwd, async () => loader);
		const connection = initializedConnection();

		const first = await registry.dispatch(connection, { id: 2, method: "skills/list", params: {} });
		version = 2;
		const cached = await registry.dispatch(connection, {
			id: 3,
			method: "skills/list",
			params: { cwds: [loaderCwd] },
		});
		const reloaded = await registry.dispatch(connection, {
			id: 4,
			method: "skills/list",
			params: { cwds: [loaderCwd], forceReload: true },
		});

		expect(skillNames(first)).toEqual(["skill-1"]);
		expect(skillNames(cached)).toEqual(["skill-1"]);
		expect(skillNames(reloaded)).toEqual(["skill-2"]);
		expect(reloadCalls).toBe(1);
	});
});

function createSkillsRegistry(
	serverCwd: string,
	resourceLoaderFactory: (cwd: string) => Promise<ResourceLoader>,
): MethodRegistry {
	const registry = createRegistry();
	registerAppServerSkillMethods(registry, { serverCwd, resourceLoaderFactory });
	return registry;
}

function initializedConnection() {
	return { initialized: true, capabilities: { experimentalApi: false } };
}

function makeSkill(name: string, filePath: string, scope: Skill["sourceInfo"]["scope"], disabled: boolean): Skill {
	return {
		name,
		description: `${name} description`,
		filePath,
		baseDir: join(filePath, ".."),
		sourceInfo: {
			path: filePath,
			source: "test",
			scope,
			origin: "top-level",
		},
		disableModelInvocation: disabled,
	};
}

function createResourceLoader(
	skills: Skill[] | (() => Skill[]),
	options: { readonly reload?: () => Promise<void> } = {},
): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: typeof skills === "function" ? skills() : skills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: options.reload ?? (async () => {}),
	};
}

async function scratchRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-app-server-skills-"));
	roots.push(root);
	return root;
}

function skillNames(response: Awaited<ReturnType<MethodRegistry["dispatch"]>>): string[] {
	if (!("result" in response) || !isRecord(response.result)) throw new Error("skills/list failed");
	const data = response.result.data;
	if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) throw new Error("skills/list shape invalid");
	const skills = data[0].skills;
	if (!Array.isArray(skills)) throw new Error("skills/list skills shape invalid");
	return skills.flatMap((skill) => (isRecord(skill) && typeof skill.name === "string" ? [skill.name] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
