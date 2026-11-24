import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDynamicSystemPromptParts } from "../../../src/core/dynamic-prompt/build.ts";
import { loadProjectContextFiles } from "../../../src/core/resource-loader.ts";

const roots: string[] = [];

function layout() {
	const root = mkdtempSync(join(tmpdir(), "senpi-user-instructions-"));
	roots.push(root);
	const home = join(root, "home");
	const agentDir = join(home, ".omo", "agent");
	const cwd = join(home, "work", "project");
	for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(agentDir, "AGENTS.md"), "Never ask me with choices.\n");
	writeFileSync(join(home, "AGENTS.md"), "Home rules.\n");
	writeFileSync(join(cwd, "AGENTS.md"), "Project rules.\n");
	return { home, agentDir, cwd };
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

describe("user instruction files are ranked as the user's own, ahead of project files", () => {
	it("marks the agent-dir and home files as user scope and leaves project files unscoped", () => {
		const { home, agentDir, cwd } = layout();

		const files = loadProjectContextFiles({ cwd, agentDir, homeDir: home });

		expect(files.map((file) => [file.path, file.scope])).toEqual([
			[join(agentDir, "AGENTS.md"), "user"],
			[join(home, "AGENTS.md"), "user"],
			[join(cwd, "AGENTS.md"), undefined],
		]);
	});

	it("recognizes the home file when home is given through a symlink", () => {
		const { home, agentDir, cwd } = layout();
		const linkedHome = `${home}-link`;
		symlinkSync(home, linkedHome);

		const files = loadProjectContextFiles({ cwd, agentDir, homeDir: linkedHome });

		expect(files.find((file) => file.path === join(home, "AGENTS.md"))?.scope).toBe("user");
	});

	it("emits the user files under their own header part, before the project header and files", () => {
		const { home, agentDir, cwd } = layout();
		const contextFiles = loadProjectContextFiles({ cwd, agentDir, homeDir: home });

		const parts = buildDynamicSystemPromptParts({
			cwd,
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles,
			skills: [],
		});

		const context = parts
			.filter((part) => part.name === "project_context")
			.map((part) => (part.source === "dynamic-prompt" ? "header" : part.source));
		expect(context).toEqual([
			"header",
			join(agentDir, "AGENTS.md"),
			join(home, "AGENTS.md"),
			"header",
			join(cwd, "AGENTS.md"),
		]);
		expect(parts.at(0)?.name).toBe("core");
	});

	it("keeps one header when only project files exist", () => {
		const parts = buildDynamicSystemPromptParts({
			cwd: "/fixture",
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [{ path: "/fixture/AGENTS.md", content: "Project rules.\n" }],
			skills: [],
		});

		expect(parts.filter((part) => part.name === "project_context").map((part) => part.source)).toEqual([
			"dynamic-prompt",
			"/fixture/AGENTS.md",
		]);
	});
});
