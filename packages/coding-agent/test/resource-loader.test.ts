import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let projectConfigDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		projectConfigDir = join(cwd, CONFIG_DIR_NAME);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("reload", () => {
		it("should initialize with empty results before reload", () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
		});

		it("should discover skills from agentDir", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Skill content here.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "test-skill")).toBe(true);
		});

		it("should ignore extra markdown files in auto-discovered skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "pi-skills", "browser-tools");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: browser-tools
description: Browser tools
---
Skill content here.`,
			);
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((d) => d.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});

		it("should discover prompts from agentDir", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				join(promptsDir, "test-prompt.md"),
				`---
description: A test prompt
---
Prompt content.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts } = loader.getPrompts();
			expect(prompts.some((p) => p.name === "test-prompt")).toBe(true);
		});

		it("should prefer project resources over user on name collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(projectConfigDir, "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(projectConfigDir, "skills", "collision-skill");
			mkdirSync(userSkillDir, { recursive: true });
			mkdirSync(projectSkillDir, { recursive: true });
			const userSkillPath = join(userSkillDir, "SKILL.md");
			const projectSkillPath = join(projectSkillDir, "SKILL.md");
			writeFileSync(
				userSkillPath,
				`---
name: collision-skill
description: user
---
User skill`,
			);
			writeFileSync(
				projectSkillPath,
				`---
name: collision-skill
description: project
---
Project skill`,
			);

			const baseTheme = JSON.parse(
				readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
			) as { name: string; vars?: Record<string, string> };
			baseTheme.name = "collision-theme";
			const userThemePath = join(agentDir, "themes", "collision.json");
			const projectThemePath = join(projectConfigDir, "themes", "collision.json");
			mkdirSync(join(agentDir, "themes"), { recursive: true });
			mkdirSync(join(projectConfigDir, "themes"), { recursive: true });
			writeFileSync(userThemePath, JSON.stringify(baseTheme, null, 2));
			if (baseTheme.vars) {
				baseTheme.vars.accent = "#ff00ff";
			}
			writeFileSync(projectThemePath, JSON.stringify(baseTheme, null, 2));

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const prompt = loader.getPrompts().prompts.find((p) => p.name === "commit");
			expect(prompt?.filePath).toBe(projectPromptPath);

			const skill = loader.getSkills().skills.find((s) => s.name === "collision-skill");
			expect(skill?.filePath).toBe(projectSkillPath);

			const theme = loader.getThemes().themes.find((t) => t.name === "collision-theme");
			expect(theme?.sourcePath).toBe(projectThemePath);
		});

		it("should load symlinked user and project extensions once", async () => {
			const sharedExtDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedExtDir, { recursive: true });
			writeFileSync(
				join(sharedExtDir, "shared.ts"),
				`export default function(pi) {
	pi.registerCommand("shared", {
		description: "shared command",
		handler: async () => {},
	});
}`,
			);

			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectConfigDir, { recursive: true });
			symlinkSync(sharedExtDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedExtDir, join(projectConfigDir, "extensions"), "dir");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			const discoveredExtensions = extensionsResult.extensions.filter(
				(extension) => !extension.path.startsWith("<builtin:"),
			);
			expect(discoveredExtensions).toHaveLength(1);
			expect(extensionsResult.errors).toEqual([]);

			// mergePaths processes project paths before user paths, so the project
			// alias is the canonical survivor.
			expect(discoveredExtensions[0].path).toBe(join(projectConfigDir, "extensions", "shared.ts"));
		});

		it("should load user extensions before trust and reuse them after trust resolves", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(projectConfigDir, "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });
			const loadCountKey = `__piTrustPreloadCount_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const globalState = globalThis as typeof globalThis & Record<string, number | undefined>;

			writeFileSync(
				join(userExtDir, "user.ts"),
				`globalThis[${JSON.stringify(loadCountKey)}] = (globalThis[${JSON.stringify(loadCountKey)}] ?? 0) + 1;
export default function(pi) {
	pi.on("project_trust", () => ({ trusted: "yes" }));
	pi.registerCommand("user-trust", {
		description: "user trust",
		handler: async () => {},
	});
}`,
			);
			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("project-trusted", {
		description: "project trusted",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			// Filter out the fork's always-loaded global-default builtin/inline extensions
			// (path prefixed with "<"); the trust gating only concerns file-backed extensions.
			const fileExtensionPaths = (result: { extensions: Array<{ path: string }> }): string[] =>
				result.extensions.map((extension) => extension.path).filter((path) => !path.startsWith("<"));
			await loader.reload({
				resolveProjectTrust: async ({ extensionsResult }) => {
					expect(fileExtensionPaths(extensionsResult)).toEqual([join(userExtDir, "user.ts")]);
					return true;
				},
			});

			const extensionsResult = loader.getExtensions();
			expect(fileExtensionPaths(extensionsResult)).toEqual([
				join(projectConfigDir, "extensions", "project.ts"),
				join(userExtDir, "user.ts"),
			]);
			expect(globalState[loadCountKey]).toBe(1);
		});

		it("should keep both extensions loaded when command names collide", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(projectConfigDir, "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });

			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "project deploy",
		handler: async () => {},
	});
	pi.registerCommand("project-only", {
		description: "project only",
		handler: async () => {},
	});
}`,
			);

			writeFileSync(
				join(userExtDir, "user.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "user deploy",
		handler: async () => {},
	});
	pi.registerCommand("user-only", {
		description: "user only",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			const discoveredExtensions = extensionsResult.extensions.filter(
				(extension) => !extension.path.startsWith("<builtin:"),
			);
			expect(discoveredExtensions).toHaveLength(2);
			expect(extensionsResult.errors.some((e) => e.error.includes('Command "/deploy" conflicts'))).toBe(false);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("project deploy");
			expect(runner.getCommand("deploy:2")?.description).toBe("user deploy");
			expect(runner.getCommand("project-only")?.description).toBe("project only");
			expect(runner.getCommand("user-only")?.description).toBe("user only");

			const commands = runner.getRegisteredCommands();
			const invocationNames = commands.map((command) => command.invocationName).filter((name) => name !== "tui");
			expect(invocationNames).toEqual(["history", "sessions", "deploy:1", "project-only", "deploy:2", "user-only"]);
		});

		it("should honor overrides for auto-discovered resources", async () => {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
			settingsManager.setThemePaths(["-themes/skip.json"]);

			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "disabled.ts"), "export default function() {}");

			const skillDir = join(agentDir, "skills", "skip-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: skip-skill
description: Skip me
---
Content`,
			);

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "skip.json"), "{}");

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const { extensions } = loader.getExtensions();
			const { skills } = loader.getSkills();
			const { prompts } = loader.getPrompts();
			const { themes } = loader.getThemes();

			expect(extensions.some((e) => e.path.endsWith("disabled.ts"))).toBe(false);
			expect(skills.some((s) => s.name === "skip-skill")).toBe(false);
			expect(prompts.some((p) => p.name === "skip")).toBe(false);
			expect(themes.some((t) => t.sourcePath?.endsWith("skip.json"))).toBe(false);
		});

		it("should discover AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles.some((f) => f.path.includes("AGENTS.md"))).toBe(true);
		});

		it("should skip AGENTS.md and CLAUDE.md discovery when noContextFiles is true", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles).toEqual([]);
		});

		it(`should ignore SYSTEM.md from cwd/${CONFIG_DIR_NAME}`, async () => {
			mkdirSync(projectConfigDir, { recursive: true });
			writeFileSync(join(projectConfigDir, "SYSTEM.md"), "You are a helpful assistant.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBeUndefined();
		});

		it("should ignore APPEND_SYSTEM.md", async () => {
			mkdirSync(projectConfigDir, { recursive: true });
			writeFileSync(join(projectConfigDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual([]);
		});

		it("should skip project resources when project is not trusted", async () => {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			const extensionsDir = join(configDir, "extensions");
			const skillDir = join(configDir, "skills", "project-skill");
			const promptsDir = join(configDir, "prompts");
			const themesDir = join(configDir, "themes");
			mkdirSync(extensionsDir, { recursive: true });
			mkdirSync(skillDir, { recursive: true });
			mkdirSync(promptsDir, { recursive: true });
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(configDir, "SYSTEM.md"), "Project system prompt.");
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
			writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
			writeFileSync(join(extensionsDir, "project.ts"), `throw new Error("should not load");`);
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: project-skill
description: Project skill
---
Project skill content`,
			);
			writeFileSync(join(promptsDir, "project.md"), "Project prompt");
			const themeData = JSON.parse(
				readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
			) as { name: string };
			themeData.name = "project-theme";
			writeFileSync(join(themesDir, "project.json"), JSON.stringify(themeData, null, 2));
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBeUndefined();
			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(agentDir, "AGENTS.md"))).toBe(
				true,
			);
			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md"))).toBe(false);
			expect(
				loader.getExtensions().extensions.some((extension) => extension.path === join(extensionsDir, "project.ts")),
			).toBe(false);
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getSkills().skills.some((skill) => skill.name === "project-skill")).toBe(false);
			expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "project")).toBe(false);
			expect(loader.getThemes().themes.some((theme) => theme.name === "project-theme")).toBe(false);
		});

		it("should discover APPEND_SYSTEM.md", async () => {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual([]);
		});

		it("should assign stable builtin identifiers to builtin extension factories", async () => {
			// given
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			// when
			await loader.reload();
			const builtinPaths = loader.getExtensions().extensions.map((extension) => extension.path);

			// then
			expect(builtinPaths).toEqual([
				"<builtin:permission-system>",
				"<builtin:gpt-apply-patch>",
				"<builtin:prompt-preset>",
				"<builtin:todowrite>",
				"<builtin:redraws>",
				"<builtin:anthropic-web-search>",
				"<builtin:anthropic-bash>",
				"<builtin:openai-web-search>",
				"<builtin:service-tier>",
				"<builtin:bash-timeout>",
				"<builtin:tool-pair-guard>",
				"<builtin:compaction>",
				"<builtin:history-search>",
				"<builtin:session-observer>",
				"<builtin:kimi-web-search>",
			]);
		});

		it("should allow settings to load only selected builtin extensions", async () => {
			// given
			mkdirSync(projectConfigDir, { recursive: true });
			writeFileSync(
				join(projectConfigDir, "settings.json"),
				JSON.stringify({ enabledBuiltinExtensions: ["bash-timeout", "compaction"] }, null, 2),
			);
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			// when
			await loader.reload();
			const builtinPaths = loader.getExtensions().extensions.map((extension) => extension.path);

			// then
			expect(builtinPaths).toEqual(["<builtin:bash-timeout>", "<builtin:compaction>"]);
		});

		it("should let disabled builtin extensions override the builtin allowlist", async () => {
			// given
			const settingsManager = SettingsManager.inMemory({
				enabledBuiltinExtensions: ["bash-timeout", "compaction"],
				disabledBuiltinExtensions: ["bash-timeout"],
			});
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

			// when
			await loader.reload();
			const builtinPaths = loader.getExtensions().extensions.map((extension) => extension.path);

			// then
			expect(builtinPaths).toEqual(["<builtin:compaction>"]);
		});

		it("should allow settings to disable selected builtin extensions", async () => {
			// given
			mkdirSync(projectConfigDir, { recursive: true });
			writeFileSync(
				join(projectConfigDir, "settings.json"),
				JSON.stringify({ disabledBuiltinExtensions: ["service-tier", "redraws"] }, null, 2),
			);
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			// when
			await loader.reload();
			const builtinPaths = loader.getExtensions().extensions.map((extension) => extension.path);

			// then
			expect(builtinPaths).not.toContain("<builtin:service-tier>");
			expect(builtinPaths).not.toContain("<builtin:redraws>");
			expect(builtinPaths).toContain("<builtin:permission-system>");
			expect(builtinPaths).toContain("<builtin:todowrite>");
		});

		it("should allow SettingsManager.inMemory() to disable selected builtin extensions", async () => {
			// given
			const settingsManager = SettingsManager.inMemory({
				disabledBuiltinExtensions: ["service-tier", "redraws"],
			});
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

			// when
			await loader.reload();
			const builtinPaths = loader.getExtensions().extensions.map((extension) => extension.path);

			// then
			expect(builtinPaths).not.toContain("<builtin:service-tier>");
			expect(builtinPaths).not.toContain("<builtin:redraws>");
			expect(builtinPaths).toContain("<builtin:permission-system>");
			expect(builtinPaths).toContain("<builtin:todowrite>");
		});

		it("should seed default global extensions into the default global agent extensions directory", async () => {
			// given
			const previousAgentDir = process.env[ENV_AGENT_DIR];
			process.env[ENV_AGENT_DIR] = agentDir;
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			try {
				// when
				await loader.reload();
				const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);

				// then
				expect(extensionPaths).toContain(join(agentDir, "extensions", "diff.js"));
				expect(extensionPaths).toContain(join(agentDir, "extensions", "files.js"));
				expect(extensionPaths).toContain(join(agentDir, "extensions", "prompt-url-widget.js"));
				expect(extensionPaths).toContain(join(agentDir, "extensions", "tps.js"));
				expect(extensionPaths).toContain("<builtin:todowrite>");
				expect(extensionPaths).toContain("<builtin:redraws>");
				expect(readFileSync(join(agentDir, "extensions", "diff.js"), "utf-8")).toContain("Generated by senpi");
			} finally {
				if (previousAgentDir === undefined) {
					delete process.env[ENV_AGENT_DIR];
				} else {
					process.env[ENV_AGENT_DIR] = previousAgentDir;
				}
			}
		});
	});

	describe("extendResources", () => {
		it("should load skills and prompts with extension metadata", async () => {
			const extraSkillDir = join(tempDir, "extra-skills", "extra-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: extra-skill
description: Extra skill
---
Extra content`,
			);

			const extraPromptDir = join(tempDir, "extra-prompts");
			mkdirSync(extraPromptDir, { recursive: true });
			const promptPath = join(extraPromptDir, "extra.md");
			writeFileSync(
				promptPath,
				`---
description: Extra prompt
---
Extra prompt content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: extraSkillDir,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
				promptPaths: [
					{
						path: promptPath,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraPromptDir,
						},
					},
				],
			});

			const { skills } = loader.getSkills();
			const loadedSkill = skills.find((skill) => skill.name === "extra-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedSkill?.sourceInfo?.path).toBe(skillPath);

			const { prompts } = loader.getPrompts();
			const loadedPrompt = prompts.find((prompt) => prompt.name === "extra");
			expect(loadedPrompt).toBeDefined();
			expect(loadedPrompt?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedPrompt?.sourceInfo?.path).toBe(promptPath);
		});

		it("should load extension resources returned as file URLs", async () => {
			const extraSkillDir = join(tempDir, "extra skills", "file-url-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: file-url-skill
description: File URL skill
---
Extra content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: pathToFileURL(extraSkillDir).href,
						metadata: {
							source: "extension:file-url",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
			});

			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const loadedSkill = skills.find((skill) => skill.name === "file-url-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.filePath).toBe(skillPath);
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:file-url");
		});
	});

	describe("noSkills option", () => {
		it("should skip skill discovery when noSkills is true", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toEqual([]);
		});

		it("should still load additional skill paths when noSkills is true", async () => {
			const customSkillDir = join(tempDir, "custom-skills");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "custom.md"),
				`---
name: custom
description: Custom skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "custom")).toBe(true);
		});
	});

	describe("override functions", () => {
		it("should apply skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("injected");
		});
	});
	describe("extension conflict detection", () => {
		it("should detect tool conflicts between extensions", async () => {
			// Create two extensions that register the same tool
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts"))).toBe(true);
		});

		it("should dedupe repeated package extensions by package name before conflict detection", async () => {
			const firstDir = join(tempDir, "first-package");
			const secondDir = join(tempDir, "second-package");
			mkdirSync(firstDir, { recursive: true });
			mkdirSync(secondDir, { recursive: true });
			writeFileSync(join(firstDir, "package.json"), JSON.stringify({ name: "same-pi-extension" }));
			writeFileSync(join(secondDir, "package.json"), JSON.stringify({ name: "same-pi-extension" }));

			const extensionSource = (description: string) => `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "same-package-tool",
    description: ${JSON.stringify(description)},
    parameters: Type.Object({}),
    execute: async () => ({ result: ${JSON.stringify(description)} }),
  });
}`;
			const firstPath = join(firstDir, "index.ts");
			const secondPath = join(secondDir, "index.ts");
			writeFileSync(firstPath, extensionSource("first package tool"));
			writeFileSync(secondPath, extensionSource("second package tool"));

			const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [firstPath, secondPath] });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.errors.some((e) => e.error.includes("same-package-tool"))).toBe(false);
			expect(
				extensionsResult.extensions.filter(
					(extension) => extension.path === firstPath || extension.path === secondPath,
				),
			).toHaveLength(1);
		});

		it("should dedupe the same git package when it is also cloned into user extensions", async () => {
			const packageName = "pi-ast-grep";
			const gitPackageDir = join(agentDir, "git", "github.com", "code-yeongyu", packageName);
			const clonedExtensionDir = join(agentDir, "extensions", packageName);
			const packageJson = JSON.stringify({ name: packageName, pi: { extensions: ["./src/index.ts"] } });
			const extensionSource = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_grep_search",
    description: "AST grep search",
    parameters: Type.Object({}),
    execute: async () => ({ result: "search" }),
  });
}`;

			for (const packageDir of [gitPackageDir, clonedExtensionDir]) {
				mkdirSync(join(packageDir, "src"), { recursive: true });
				writeFileSync(join(packageDir, "package.json"), packageJson);
				writeFileSync(join(packageDir, "src", "index.ts"), extensionSource);
			}

			const settingsManager = SettingsManager.inMemory({ packages: [`git:github.com/code-yeongyu/${packageName}`] });
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			const duplicatePaths = [join(gitPackageDir, "src", "index.ts"), join(clonedExtensionDir, "src", "index.ts")];
			expect(extensionsResult.errors.some((error) => error.error.includes('Tool "ast_grep_search" conflicts'))).toBe(
				false,
			);
			expect(
				extensionsResult.extensions.filter((extension) => duplicatePaths.includes(extension.path)),
			).toHaveLength(1);
		});

		it("should shadow installed packages that are already shipped as active builtins", async () => {
			const packageName = "pi-todotools";
			const packageDir = join(agentDir, "extensions", packageName);
			const extensionPath = join(packageDir, "src", "index.ts");
			mkdirSync(join(packageDir, "src"), { recursive: true });
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({ name: packageName, pi: { extensions: ["./src/index.ts"] } }),
			);
			writeFileSync(
				extensionPath,
				`export default function(pi) {
  pi.registerCommand("external-todo", {
    description: "external todo",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);
			expect(extensionPaths).toContain("<builtin:todowrite>");
			expect(extensionPaths).not.toContain(extensionPath);
		});

		it("should load a vendored package when its matching builtin is disabled", async () => {
			const packageName = "pi-todotools";
			const packageDir = join(agentDir, "extensions", packageName);
			const extensionPath = join(packageDir, "src", "index.ts");
			mkdirSync(join(packageDir, "src"), { recursive: true });
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({ name: packageName, pi: { extensions: ["./src/index.ts"] } }),
			);
			writeFileSync(
				extensionPath,
				`export default function(pi) {
  pi.registerCommand("external-todo", {
    description: "external todo",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ disabledBuiltinExtensions: ["todowrite"] }),
			});
			await loader.reload();

			const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);
			expect(extensionPaths).not.toContain("<builtin:todowrite>");
			expect(extensionPaths).toContain(extensionPath);
		});

		it("should keep explicit CLI vendored packages even when matching builtins are active", async () => {
			const packageName = "pi-apply-patch";
			const packageDir = join(tempDir, packageName);
			const extensionPath = join(packageDir, "src", "index.ts");
			mkdirSync(join(packageDir, "src"), { recursive: true });
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({ name: packageName, pi: { extensions: ["./src/index.ts"] } }),
			);
			writeFileSync(
				extensionPath,
				`export default function(pi) {
  pi.registerCommand("explicit-apply-patch", {
    description: "explicit apply patch",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [packageDir] });
			await loader.reload();

			const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);
			expect(extensionPaths).toContain("<builtin:gpt-apply-patch>");
			expect(extensionPaths).toContain(extensionPath);
		});

		it("should keep distinct extension entries from the same package", async () => {
			const packageDir = join(tempDir, "multi-extension-package");
			const extensionsDir = join(packageDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "multi-extension-package" }));

			const extensionSource = (toolName: string) => `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: ${JSON.stringify(toolName)},
    description: ${JSON.stringify(toolName)},
    parameters: Type.Object({}),
    execute: async () => ({ result: ${JSON.stringify(toolName)} }),
  });
}`;
			const firstPath = join(extensionsDir, "first.ts");
			const secondPath = join(extensionsDir, "second.ts");
			writeFileSync(firstPath, extensionSource("first-package-tool"));
			writeFileSync(secondPath, extensionSource("second-package-tool"));

			const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [firstPath, secondPath] });
			await loader.reload();

			const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);
			expect(extensionPaths).toContain(firstPath);
			expect(extensionPaths).toContain(secondPath);
		});

		it("should suppress builtin tool conflicts because load order handles precedence", async () => {
			const externalExtDir = join(agentDir, "extensions", "external-apply-patch");
			mkdirSync(externalExtDir, { recursive: true });
			writeFileSync(
				join(externalExtDir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "apply_patch",
    description: "External apply patch",
    parameters: Type.Object({}),
    execute: async () => ({ result: "external" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((error) => error.error.includes('Tool "apply_patch" conflicts'))).toBe(false);

			const extensionsResult = loader.getExtensions();
			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-builtin-conflict.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getToolDefinition("apply_patch")?.description).not.toBe("External apply patch");
		});

		it("should keep builtin flag defaults ahead of external duplicate flags", async () => {
			const externalExtDir = join(agentDir, "extensions", "external-flags");
			mkdirSync(externalExtDir, { recursive: true });
			writeFileSync(
				join(externalExtDir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function(pi: ExtensionAPI) {
  pi.registerFlag("disable-todo-continuation", {
    type: "boolean",
    default: true,
    description: "External continuation override",
  });
  pi.registerFlag("permission", {
    type: "boolean",
    default: true,
    description: "External permission override",
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.errors.some((error) => error.error.includes('Flag "--permission" conflicts'))).toBe(
				false,
			);
			expect(extensionsResult.runtime.flagValues.get("disable-todo-continuation")).toBe(false);
			expect(extensionsResult.runtime.flagValues.has("permission")).toBe(false);
		});

		it("should validate CLI flags against builtin metadata before external duplicate flags", async () => {
			const externalExtDir = join(agentDir, "extensions", "external-permission-flag");
			mkdirSync(externalExtDir, { recursive: true });
			writeFileSync(
				join(externalExtDir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function(pi: ExtensionAPI) {
  pi.registerFlag("permission", {
    type: "boolean",
    default: true,
    description: "External permission override",
  });
}`,
			);

			const authStorage = AuthStorage.create(join(tempDir, "auth-cli-flag.json"));
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				modelRegistry: ModelRegistry.create(authStorage),
				settingsManager: SettingsManager.inMemory(),
				extensionFlagValues: new Map([["permission", "bash=allow"]]),
			});

			expect(services.diagnostics).toEqual([]);
			expect(services.resourceLoader.getExtensions().runtime.flagValues.get("permission")).toBe("bash=allow");
		});

		it("should prefer explicit CLI extensions over discovered extensions when commands and tools conflict", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			const explicitExtPath = join(tempDir, "explicit-extension.ts");

			writeFileSync(
				join(globalExtDir, "global.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  pi.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
			);

			writeFileSync(
				explicitExtPath,
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  pi.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: [explicitExtPath],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			const diskExtensions = extensionsResult.extensions.filter(
				(extension) => !extension.path.startsWith("<builtin:"),
			);
			expect(diskExtensions[0]?.path).toBe(explicitExtPath);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
			expect(runner.getCommand("deploy:2")?.description).toBe("global command");
			expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
		});
	});
});
