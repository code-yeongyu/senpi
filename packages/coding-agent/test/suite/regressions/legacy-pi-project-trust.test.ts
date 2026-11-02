/**
 * Legacy `.pi` project resources follow project trust on the real launch path: `main()` decides
 * trust for the folder, then the session's resource loader discovers what that decision allows.
 * A folder whose only project resources live in `.pi/` asks for trust like any other project,
 * and nothing under `.pi/` loads until the folder is trusted.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { main } from "../../../src/main.ts";
import { SCAN_MIGRATIONS, writeCompletedScanMigrations } from "../../../src/migrations-state.ts";
import { stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.ts";

const launched = vi.hoisted(() => ({ runtimes: [] as unknown[], prompts: [] as string[], answer: "" }));

vi.mock("../../../src/modes/interactive/interactive-mode.ts", () => ({
	InteractiveMode: class {
		constructor(runtime: unknown) {
			launched.runtimes.push(runtime);
		}
		async init(): Promise<void> {}
		async run(): Promise<void> {}
		stop(): void {}
	},
}));

vi.mock("../../../src/cli/startup-ui.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/cli/startup-ui.ts")>();
	return {
		...actual,
		shouldRunFirstTimeSetup: () => false,
		showStartupSelector: async <T>(
			_settings: unknown,
			title: string,
			options: ReadonlyArray<{ label: string; value: T }>,
		): Promise<T | undefined> => {
			launched.prompts.push(title);
			return options.find((option) => option.label === launched.answer)?.value;
		},
	};
});

const ALL = {
	skills: ["pi-skill"],
	extensions: ["pi-ext.ts"],
	prompts: ["pi-prompt"],
	themes: ["pi-theme"],
	hooks: ["pi-hooks.json"],
	extensionRan: true,
};
const NONE = { skills: [], extensions: [], prompts: [], themes: [], hooks: [], extensionRan: false };

let root: string;
let agentDir: string;
let cwd: string;
let marker: string;

const writeFile = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
};

function writeLegacyPiResources(): void {
	const pi = join(cwd, ".pi");
	writeFile(join(pi, "skills", "pi-skill", "SKILL.md"), "---\nname: pi-skill\ndescription: Legacy skill.\n---\n");
	writeFile(
		join(pi, "extensions", "pi-ext.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "ran"); }\n`,
	);
	writeFile(join(pi, "prompts", "pi-prompt.md"), "---\ndescription: Legacy prompt.\n---\nhello\n");
	const dark = JSON.parse(
		readFileSync(new URL("../../../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
	);
	writeFile(join(pi, "themes", "pi-theme.json"), JSON.stringify({ ...dark, name: "pi-theme" }));
	writeFile(join(pi, "hooks", "pi-hooks.json"), JSON.stringify({ hooks: {} }));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "legacy-pi-project-trust-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	marker = join(root, "pi-extension-ran");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".git"), { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("HOME", root);
	// An install past its first launch: the one-time copy of project .pi dirs into the config
	// dir already ran, so a new project's .pi/ is read only through legacy discovery.
	writeCompletedScanMigrations(SCAN_MIGRATIONS, agentDir);
	launched.runtimes.length = 0;
	launched.prompts.length = 0;
	launched.answer = "";
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

async function launchInteractive() {
	const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
	const previousCwd = process.cwd();
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	process.stdin.isTTY = true;
	process.stdout.isTTY = true;
	process.chdir(cwd);
	try {
		await main([]);
	} finally {
		process.chdir(previousCwd);
		process.stdin.isTTY = tty.stdin;
		process.stdout.isTTY = tty.stdout;
		stopThemeWatcher();
	}
	const runtime = launched.runtimes.at(-1);
	if (!(runtime instanceof AgentSessionRuntime)) throw new Error("interactive launch did not start a runtime");
	const loader = runtime.session.resourceLoader;
	if (!(loader instanceof DefaultResourceLoader)) throw new Error("expected the default resource loader");
	const inProject = (path: string | undefined) => path?.includes(`${join("project", ".pi")}`) === true;
	const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
	const resources = {
		skills: loader
			.getSkills()
			.skills.filter((s) => inProject(s.filePath))
			.map((s) => s.name),
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
		extensionRan: existsSync(marker),
	};
	await runtime.dispose();
	return { resources, prompts: [...launched.prompts] };
}

describe("legacy .pi project resources on launch", { timeout: 60_000 }, () => {
	it("asks for trust when the project's only resources are in .pi/", async () => {
		writeLegacyPiResources();
		launched.answer = "Do not trust";

		const { prompts } = await launchInteractive();

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Trust project folder?");
	});

	it("loads nothing from .pi/ when trust is declined", async () => {
		writeLegacyPiResources();
		launched.answer = "Do not trust";

		const { resources } = await launchInteractive();

		expect(resources).toEqual(NONE);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(false);
	});

	it("loads every .pi/ resource kind when trust is accepted", async () => {
		writeLegacyPiResources();
		launched.answer = "Trust";

		const { resources } = await launchInteractive();

		expect(resources).toEqual(ALL);
	});

	it("respects a saved decision without asking", async () => {
		writeLegacyPiResources();
		new ProjectTrustStore(agentDir).set(cwd, false);

		const declined = await launchInteractive();

		expect(declined.prompts).toEqual([]);
		expect(declined.resources).toEqual(NONE);

		new ProjectTrustStore(agentDir).set(cwd, true);

		const trusted = await launchInteractive();

		expect(trusted.prompts).toEqual([]);
		expect(trusted.resources).toEqual(ALL);
	});

	it("opens a project with no trust-requiring resources without asking", async () => {
		const { prompts, resources } = await launchInteractive();

		expect(prompts).toEqual([]);
		expect(resources).toEqual(NONE);
	});
});
