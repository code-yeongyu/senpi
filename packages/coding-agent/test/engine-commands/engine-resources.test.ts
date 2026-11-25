import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, getAgentDir } from "../../src/config.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { openResourceConfig } from "../../src/engine/config.ts";
import { engine } from "../../src/engine/index.ts";
import { ConfigSelectorComponent } from "../../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

let root: string;
let projectDir: string;
let extension: string;
let originalCwd: string;

const globalSettingsPath = () => join(getAgentDir(), "settings.json");
const projectSettingsPath = () => join(projectDir, CONFIG_DIR_NAME, "settings.json");
const readJson = (path: string): unknown => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

function resetSettings(): void {
	rmSync(globalSettingsPath(), { force: true });
	rmSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true, force: true });
}

async function pressInTui(scope: "global" | "project", presses: number): Promise<void> {
	const opened = await openResourceConfig(
		{ cwd: projectDir, agentDir: getAgentDir(), extensionFactories: builtInExtensions },
		{ local: scope === "project", trust: true },
	);
	if (opened.kind !== "ok") throw new Error(opened.error.message);
	const { global, project, settingsManager } = opened.value;
	initTheme("dark");
	const selector = new ConfigSelectorComponent(
		{ global, project },
		settingsManager,
		projectDir,
		getAgentDir(),
		() => {},
		() => {},
		() => {},
		400,
		scope,
	);
	const list = selector.getResourceList();
	list.handleInput("probe-7450");
	for (let press = 0; press < presses; press += 1) list.handleInput(" ");
	await settingsManager.flush();
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-resources-")));
	projectDir = join(root, "project");
	mkdirSync(projectDir, { recursive: true });
	extension = join(getAgentDir(), "extensions", "probe-7450.ts");
	mkdirSync(join(getAgentDir(), "extensions"), { recursive: true });
	writeFileSync(extension, "export default function () {}\n");
	vi.stubEnv("HOME", root);
	originalCwd = process.cwd();
	process.chdir(projectDir);
	resetSettings();
});

afterEach(() => {
	process.chdir(originalCwd);
	vi.unstubAllEnvs();
	resetSettings();
	rmSync(join(getAgentDir(), "extensions"), { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

async function probe() {
	const resolved = await engine.config.resources({ trust: true });
	if (resolved.kind !== "ok") throw new Error("resources refused");
	const item = resolved.value.global.extensions.find((entry) => entry.path === extension);
	if (item === undefined) throw new Error("probe extension not resolved");
	return { item, source: item.metadata.source, resource: { type: "extensions", path: extension } as const };
}

describe("config.resources and config.setResource write what the config TUI writes", () => {
	it("resolves the probe enabled, and refuses an untrusted local scope", async () => {
		const { item } = await probe();
		expect(item.enabled).toBe(true);
		expect(await engine.config.resources({ local: true, trust: false })).toMatchObject({
			kind: "error",
			error: { code: "project_untrusted" },
		});
	});

	it("global: disabling then enabling matches one and two space presses", async () => {
		const { source, resource } = await probe();
		for (const [presses, enabled] of [
			[1, false],
			[2, true],
		] as const) {
			resetSettings();
			await pressInTui("global", presses);
			const byTui = readJson(globalSettingsPath());
			resetSettings();
			if (!enabled) {
				expect(await engine.config.setResource({ source, resource, enabled })).toMatchObject({
					kind: "ok",
					value: { enabled },
				});
			} else {
				await engine.config.setResource({ source, resource, enabled: false });
				await engine.config.setResource({ source, resource, enabled: true });
			}
			expect(readJson(globalSettingsPath())).toEqual(byTui);
		}
		expect(readJson(globalSettingsPath())).toEqual({ extensions: ["+extensions/probe-7450.ts"] });
	});

	it("project: unload, load and back to inherit match the TUI's cycle", async () => {
		const { source, resource } = await probe();
		const states = ["unload", "load", "inherit"] as const;
		for (let presses = 1; presses <= states.length; presses += 1) {
			resetSettings();
			await pressInTui("project", presses);
			const byTui = readJson(projectSettingsPath());
			resetSettings();
			for (const state of states.slice(0, presses)) {
				const changed = await engine.config.setResource({ local: true, trust: true, source, resource, state });
				expect(changed).toMatchObject({ kind: "ok", value: { state, enabled: state !== "unload" } });
			}
			expect(readJson(projectSettingsPath()), `after ${presses} press(es)`).toEqual(byTui);
		}
	});

	it("refuses a resource the source does not have", async () => {
		const { source } = await probe();
		expect(
			await engine.config.setResource({ source, resource: { type: "skills", path: extension }, enabled: true }),
		).toMatchObject({ kind: "error", error: { code: "not_found" } });
	});
});
