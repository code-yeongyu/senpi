import { describe, expect, test, vi } from "vitest";
import { buildDynamicSystemPrompt } from "../../src/core/dynamic-prompt/build.ts";

describe("buildDynamicSystemPrompt", () => {
	const baseOptions = {
		cwd: "/test/project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: {
			read: "Read file contents",
			bash: "Execute shell commands",
			edit: "Apply surgical edits",
			write: "Create or overwrite files",
		},
		promptGuidelines: [],
		contextFiles: [],
		skills: [],
	};

	test("includes tool section with categorized tools", () => {
		const prompt = buildDynamicSystemPrompt(baseOptions);

		expect(prompt).toContain("read");
		expect(prompt).toContain("bash");
	});

	test("does not include tuning section by default", () => {
		const prompt = buildDynamicSystemPrompt(baseOptions);

		expect(prompt).not.toContain("## Model Notes");
	});

	test("includes tuning section when provided", () => {
		const prompt = buildDynamicSystemPrompt({
			...baseOptions,
			tuningSection: "## Model Notes (Test)\n\nCustom tuning content.",
		});

		expect(prompt).toContain("## Model Notes (Test)");
		expect(prompt).toContain("Custom tuning content.");
	});

	// senpi#2093: date and cwd reach the model as an environment-context message instead.
	test("carries neither the current date nor the working directory", () => {
		const prompt = buildDynamicSystemPrompt(baseOptions);

		expect(prompt).not.toContain("Current date:");
		expect(prompt).not.toContain("Current working directory:");
		expect(prompt).not.toContain("/test/project");
	});

	test("is byte-identical across dates and working directories", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
			const first = buildDynamicSystemPrompt(baseOptions);
			vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
			const second = buildDynamicSystemPrompt({ ...baseOptions, cwd: "C:\\Users\\test\\other" });

			expect(second).toBe(first);
		} finally {
			vi.useRealTimers();
		}
	});

	test("appends AGENTS.md context files", () => {
		const prompt = buildDynamicSystemPrompt({
			...baseOptions,
			contextFiles: [{ path: "/project/AGENTS.md", content: "# My Project Rules" }],
		});

		expect(prompt).toContain("# My Project Rules");
		expect(prompt).toContain("/project/AGENTS.md");
	});

	test("appends skills in XML format", () => {
		const prompt = buildDynamicSystemPrompt({
			...baseOptions,
			skills: [
				{
					name: "git-master",
					description: "Git operations expert",
					filePath: "/skills/git-master/SKILL.md",
					baseDir: "/skills/git-master",
					sourceInfo: { path: "/skills/git-master/SKILL.md", source: "local", scope: "user", origin: "top-level" },
					disableModelInvocation: false,
				},
			],
		});

		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("git-master");
		expect(prompt).toContain("Git operations expert");
	});

	test("excludes skills with disableModelInvocation", () => {
		const prompt = buildDynamicSystemPrompt({
			...baseOptions,
			skills: [
				{
					name: "hidden-skill",
					description: "Should not appear",
					filePath: "/skills/hidden/SKILL.md",
					baseDir: "/skills/hidden",
					sourceInfo: { path: "/skills/hidden/SKILL.md", source: "local", scope: "user", origin: "top-level" },
					disableModelInvocation: true,
				},
			],
		});

		expect(prompt).not.toContain("hidden-skill");
	});

	test("includes custom prompt guidelines", () => {
		const prompt = buildDynamicSystemPrompt({
			...baseOptions,
			promptGuidelines: ["Use read to examine files instead of cat or sed."],
		});

		expect(prompt).toContain("Use read to examine files instead of cat or sed.");
	});
});
