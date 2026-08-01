import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, resolveAgentDir } from "../src/config.ts";
import { FileSettingsStorage, getSettingsPath, SettingsManager } from "../src/core/settings-manager.ts";
import { findNearestParentConfigDir, MAX_PARENT_CONFIG_SEARCH_DEPTH } from "../src/nearest-parent-config.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-nearest-parent-"));
	tempDirs.push(dir);
	return dir;
}

function createAgentDir(root: string): string {
	const agentDir = join(root, CONFIG_DIR_NAME, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("nearest parent config discovery", () => {
	it("lets SENPI_CODING_AGENT_DIR win over a nearer project agent directory", () => {
		const root = createTempDir();
		const project = join(root, "project");
		const cwd = join(project, "src", "feature");
		const override = join(root, "override");
		createAgentDir(project);
		mkdirSync(cwd, { recursive: true });
		process.env[ENV_AGENT_DIR] = override;
		vi.spyOn(process, "cwd").mockReturnValue(cwd);

		expect(getAgentDir()).toBe(override);
		expect(resolveAgentDir(cwd, join(root, "home"), override)).toBe(override);
	});

	it("finds a project agent directory from several levels below its root", () => {
		const root = createTempDir();
		const home = join(root, "home");
		const project = join(root, "project");
		const cwd = join(project, "src", "feature", "nested");
		const agentDir = createAgentDir(project);
		mkdirSync(cwd, { recursive: true });

		expect(resolveAgentDir(cwd, home)).toBe(agentDir);
	});

	it("uses the nearest nested project agent directory", () => {
		const root = createTempDir();
		const home = join(root, "home");
		const outerProject = join(root, "outer");
		const innerProject = join(outerProject, "packages", "inner");
		const cwd = join(innerProject, "src", "feature");
		createAgentDir(outerProject);
		const innerAgentDir = createAgentDir(innerProject);
		mkdirSync(cwd, { recursive: true });

		expect(resolveAgentDir(cwd, home)).toBe(innerAgentDir);
	});

	it("falls back to the home agent directory without treating home as a project", () => {
		const root = createTempDir();
		const home = join(root, "home");
		const cwd = join(home, "project", "src");
		const homeAgentDir = createAgentDir(home);
		mkdirSync(cwd, { recursive: true });

		expect(findNearestParentConfigDir(cwd, home, CONFIG_DIR_NAME, "agent")).toBeUndefined();
		expect(resolveAgentDir(cwd, home)).toBe(homeAgentDir);
	});

	it("refuses symlinked project config directories", () => {
		const root = createTempDir();
		const home = join(root, "home");
		const project = join(root, "project");
		const cwd = join(project, "src");
		const linkedConfigSource = join(root, "linked-config");
		const homeAgentDir = createAgentDir(home);
		createAgentDir(linkedConfigSource);
		mkdirSync(cwd, { recursive: true });
		symlinkSync(join(linkedConfigSource, CONFIG_DIR_NAME), join(project, CONFIG_DIR_NAME), "dir");

		expect(resolveAgentDir(cwd, home)).toBe(homeAgentDir);
	});

	it("stops before exceeding the parent walk depth limit", () => {
		const root = createTempDir();
		const project = join(root, "project");
		let cwd = project;
		for (let depth = 0; depth <= MAX_PARENT_CONFIG_SEARCH_DEPTH; depth += 1) {
			cwd = join(cwd, `level-${depth}`);
		}
		createAgentDir(project);
		mkdirSync(cwd, { recursive: true });

		expect(findNearestParentConfigDir(cwd, join(root, "home"), CONFIG_DIR_NAME, "agent")).toBeUndefined();
	});
});

describe("project settings discovery", () => {
	it("loads nearest project settings from a deep subdirectory", () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const cwd = join(project, "src", "feature", "nested");
		const home = join(root, "home");
		const projectSettingsPath = join(project, CONFIG_DIR_NAME, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
		writeFileSync(projectSettingsPath, JSON.stringify({ theme: "project" }));

		expect(getSettingsPath(cwd, agentDir, "project", home)).toBe(projectSettingsPath);
		expect(SettingsManager.create(cwd, agentDir).getTheme()).toBe("project");
	});

	it("writes project settings to the nearest config within the fixture", async () => {
		const root = createTempDir();
		const home = join(root, "home");
		const project = join(root, "project");
		const cwd = join(project, "src", "feature");
		const agentDir = join(root, "agent");
		const outerSettingsPath = join(root, CONFIG_DIR_NAME, "settings.json");
		const projectSettingsPath = join(project, CONFIG_DIR_NAME, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
		const manager = SettingsManager.fromStorage(new FileSettingsStorage(cwd, agentDir, home));

		manager.setProjectPackages([{ source: "file:./fixture-package" }]);
		await manager.flush();

		expect(readFileSync(projectSettingsPath, "utf-8")).toContain('"source": "file:./fixture-package"');
		expect(existsSync(outerSettingsPath)).toBe(false);
	});

	it("keeps the cwd settings path when no project config exists", () => {
		const root = createTempDir();
		const home = join(root, "home");
		const cwd = join(home, "cwd");
		mkdirSync(join(home, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(cwd, { recursive: true });

		expect(getSettingsPath(cwd, join(root, "agent"), "project", home)).toBe(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
		);
	});
});
