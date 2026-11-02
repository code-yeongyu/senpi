import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { clearResolvedPathsMemo } from "../src/core/resolved-paths-memo.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

/**
 * A shared host builds one DefaultResourceLoader per session, and every one of
 * them ran package resolution over the same agent dir: ~68 ms of loop CPU per
 * open on the daemon (senpi#1844). Resolution is now memoized per host on the
 * inputs that decide it. This pins the two halves of that contract with real
 * loaders: same inputs share one resolution, and a settings change does not.
 */
describe("DefaultResourceLoader package resolution memo", () => {
	let scratch: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		clearResolvedPathsMemo();
		scratch = mkdtempSync(join(tmpdir(), "senpi-resolve-memo-"));
		cwd = join(scratch, "cwd");
		agentDir = join(scratch, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	const makeLoader = () =>
		new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			extensionFactories: [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

	it("resolves once for two loaders with the same inputs", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");

		await makeLoader().reload();
		await makeLoader().reload();

		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("resolves again once the settings change", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");

		await makeLoader().reload();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@example/x"] }));
		await makeLoader().reload();

		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("re-resolves on a re-load of the same loader, and a later fresh loader sees that result", async () => {
		// A package's own manifest is not part of the key, so the re-load signal has
		// to carry disk changes through the memo. This is the hole CI found.
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
		const loader = makeLoader();

		await loader.reload();
		await loader.reload();
		const afterReload = resolve.mock.calls.length;
		await makeLoader().reload();

		expect(afterReload).toBe(2);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("resolves once through the project-trust path too", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
		const reloadOptions = { resolveProjectTrust: () => Promise.resolve(true) };

		await makeLoader().reload(reloadOptions);
		const afterFirst = resolve.mock.calls.length;
		await makeLoader().reload(reloadOptions);

		expect(afterFirst).toBeGreaterThan(0);
		expect(resolve).toHaveBeenCalledTimes(afterFirst);
	});

	it("shares one in-flight resolution across concurrent loaders", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");

		await Promise.all([makeLoader().reload(), makeLoader().reload(), makeLoader().reload()]);

		expect(resolve).toHaveBeenCalledTimes(1);
	});

	// senpi#2371: resolution reads the project trust state, so the memo key must carry it.
	// Startup resolves once untrusted (the pre-trust pass) and once after the saved decision;
	// with no project settings file both passes had the same key and shared one result, in
	// both directions: a trusted pass could get the untrusted result, and an untrusted open
	// could get a trusted open's project resources.
	describe("project trust from a saved decision (senpi#2371)", () => {
		const ALL = {
			skills: ["agents-skill", "project-skill"],
			extensions: ["project-ext.ts"],
			prompts: ["project-prompt"],
			themes: ["project-theme"],
			hooks: ["project-hooks.json"],
		};
		const NONE = { skills: [], extensions: [], prompts: [], themes: [], hooks: [] };
		const noPromptContext: ProjectTrustContext = {
			cwd: "",
			mode: "print",
			hasUI: false,
			ui: {
				select: () => Promise.reject(new Error("a saved decision must not prompt")),
				confirm: () => Promise.reject(new Error("a saved decision must not prompt")),
				input: () => Promise.reject(new Error("a saved decision must not prompt")),
				notify: () => {},
			},
		};

		const writeFile = (path: string, content: string) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		};

		// Every project resource kind resolve() returns, and no project settings file.
		beforeEach(() => {
			vi.stubEnv("HOME", scratch);
			mkdirSync(join(cwd, ".git"));
			const project = join(cwd, CONFIG_DIR_NAME);
			const skill = (name: string) => `---\nname: ${name}\ndescription: Project skill behind trust.\n---\n`;
			writeFile(join(cwd, ".agents", "skills", "agents-skill", "SKILL.md"), skill("agents-skill"));
			writeFile(join(project, "skills", "project-skill", "SKILL.md"), skill("project-skill"));
			writeFile(join(project, "extensions", "project-ext.ts"), "export default function () {}\n");
			writeFile(join(project, "prompts", "project-prompt.md"), "---\ndescription: Project prompt.\n---\nhello\n");
			const dark = JSON.parse(
				readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
			);
			writeFile(join(project, "themes", "project-theme.json"), JSON.stringify({ ...dark, name: "project-theme" }));
			writeFile(join(project, "hooks", "project-hooks.json"), JSON.stringify({ hooks: {} }));
		});

		const makeTrustLoader = (projectTrusted: boolean) =>
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
				extensionFactories: [],
			});

		const projectResources = (loader: DefaultResourceLoader) => {
			const inProject = (path: string | undefined) => path?.startsWith(cwd) === true;
			const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
			return {
				skills: loader
					.getSkills()
					.skills.filter((s) => inProject(s.filePath))
					.map((s) => s.name)
					.sort(),
				extensions: loader
					.getExtensions()
					.extensions.map((e) => e.path)
					.filter(inProject)
					.map(base),
				prompts: loader
					.getPrompts()
					.prompts.filter((p) => inProject(p.filePath))
					.map((p) => p.name),
				themes: loader
					.getThemes()
					.themes.filter((t) => inProject(t.sourcePath))
					.map((t) => t.name),
				hooks: loader.getLoadedHookSources().projectHookSourcePaths.filter(inProject).map(base),
			};
		};

		// Mirrors main.ts: no cached decision, so the loader starts untrusted and asks.
		const startUp = async () => {
			const trustStore = new ProjectTrustStore(agentDir);
			const loader = makeTrustLoader(false);
			await loader.reload({
				resolveProjectTrust: ({ extensionsResult }) =>
					resolveProjectTrusted({ cwd, trustStore, extensionsResult, projectTrustContext: noPromptContext }),
			});
			const prompt = buildSystemPrompt({ cwd, skills: loader.getSkills().skills });
			return { resources: projectResources(loader), prompt };
		};

		it("loads a trusted project's resources, .agents/skills included, with no project settings file", async () => {
			new ProjectTrustStore(agentDir).set(cwd, true);

			const { resources, prompt } = await startUp();

			expect(resources).toEqual(ALL);
			expect(prompt).toContain("<name>agents-skill</name>");
		});

		it("loads none of an untrusted project's resources", async () => {
			new ProjectTrustStore(agentDir).set(cwd, false);

			const { resources, prompt } = await startUp();

			expect(resources).toEqual(NONE);
			expect(prompt).not.toContain("agents-skill");
		});

		it("loads none of an untrusted project's resources after a trusted open of the same folder", async () => {
			const trusted = makeTrustLoader(true);
			await trusted.reload();
			expect(projectResources(trusted)).toEqual(ALL);
			new ProjectTrustStore(agentDir).set(cwd, false);

			const { resources, prompt } = await startUp();

			expect(resources).toEqual(NONE);
			expect(prompt).not.toContain("agents-skill");
		});
	});
});
