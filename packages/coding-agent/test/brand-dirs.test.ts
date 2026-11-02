import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATION_MARKER, migrateEngineStateToBrandDir } from "../src/brand-dir-migration.ts";
import { findNearestParentConfigDir } from "../src/nearest-parent-config.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "brand-dirs-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function seedLegacyAgentDir(): string {
	const legacy = join(root, ".senpi", "agent");
	mkdirSync(join(legacy, "sessions", "project"), { recursive: true });
	mkdirSync(join(legacy, "cache"), { recursive: true });
	mkdirSync(join(legacy, "logs"), { recursive: true });
	writeFileSync(join(legacy, "settings.json"), '{"theme":"dark"}');
	writeFileSync(join(legacy, "auth.json"), '{"anthropic":{}}');
	writeFileSync(join(legacy, "sessions", "project", "a.jsonl"), "{}");
	writeFileSync(join(legacy, "cache", "blob"), "cache");
	writeFileSync(join(legacy, "senpi-debug.log"), "log");
	return legacy;
}

describe("flat-layout project probe", () => {
	test("accepts a config directory only when it holds the settings file", () => {
		const project = join(root, "workspace", "pkg");
		mkdirSync(join(root, "workspace", ".omo", "plans"), { recursive: true });
		mkdirSync(project, { recursive: true });

		expect(findNearestParentConfigDir(project, root, ".omo", undefined, "settings.json")).toBeUndefined();

		writeFileSync(join(root, "workspace", ".omo", "settings.json"), "{}");

		expect(findNearestParentConfigDir(project, root, ".omo", undefined, "settings.json")).toBe(
			join(root, "workspace", ".omo"),
		);
	});

	test("still matches the engine layout through its agent subdirectory", () => {
		const project = join(root, "workspace");
		mkdirSync(join(project, ".senpi", "agent"), { recursive: true });

		expect(findNearestParentConfigDir(project, root, ".senpi", "agent")).toBe(join(project, ".senpi"));
	});
});

describe("copy-forward migration", () => {
	test("copies engine state, skips regenerables and leaves the original untouched", () => {
		const legacy = seedLegacyAgentDir();
		const brandDir = join(root, ".omo");

		const result = migrateEngineStateToBrandDir(legacy, brandDir);

		expect(result.migrated).toBe(true);
		expect(readFileSync(join(brandDir, "settings.json"), "utf-8")).toBe('{"theme":"dark"}');
		expect(existsSync(join(brandDir, "auth.json"))).toBe(true);
		expect(existsSync(join(brandDir, "sessions", "project", "a.jsonl"))).toBe(true);
		expect(existsSync(join(brandDir, "cache"))).toBe(false);
		expect(existsSync(join(brandDir, "logs"))).toBe(false);
		expect(existsSync(join(brandDir, "senpi-debug.log"))).toBe(false);
		expect(existsSync(join(brandDir, MIGRATION_MARKER))).toBe(true);
		expect(existsSync(join(legacy, "settings.json"))).toBe(true);
		expect(existsSync(join(legacy, "sessions", "project", "a.jsonl"))).toBe(true);
	});

	test("never overwrites state the branded install already has", () => {
		const legacy = seedLegacyAgentDir();
		const brandDir = join(root, ".omo");
		mkdirSync(brandDir, { recursive: true });
		writeFileSync(join(brandDir, "settings.json"), '{"theme":"light"}');

		const result = migrateEngineStateToBrandDir(legacy, brandDir);

		expect(result.migrated).toBe(false);
		expect(readFileSync(join(brandDir, "settings.json"), "utf-8")).toBe('{"theme":"light"}');
	});

	test("completes an interrupted copy on the next run, then stops repeating", () => {
		const legacy = seedLegacyAgentDir();
		const brandDir = join(root, ".omo");
		mkdirSync(join(brandDir, "sessions"), { recursive: true });

		const first = migrateEngineStateToBrandDir(legacy, brandDir);
		expect(first.migrated).toBe(true);
		expect(first.copied).toContain("auth.json");

		writeFileSync(join(legacy, "models.json"), "{}");
		const second = migrateEngineStateToBrandDir(legacy, brandDir);

		expect(second.migrated).toBe(false);
		expect(existsSync(join(brandDir, "models.json"))).toBe(false);
	});

	// code-yeongyu/oh-my-openagent#9727: the OmO desktop app owns `~/.omo/desktop*` (omo-desktop-app#1829).
	test("never creates or copies into the OmO desktop's reserved entries", () => {
		const legacy = seedLegacyAgentDir();
		mkdirSync(join(legacy, "desktop"), { recursive: true });
		mkdirSync(join(legacy, "desktop.init-abc"), { recursive: true });
		writeFileSync(join(legacy, "desktop", "x"), "engine");
		writeFileSync(join(legacy, "desktop.init-abc", "y"), "engine");
		const brandDir = join(root, ".omo");
		mkdirSync(join(brandDir, "desktop"), { recursive: true });
		writeFileSync(join(brandDir, "desktop", "app.db"), "desktop-owned");

		const result = migrateEngineStateToBrandDir(legacy, brandDir);

		expect(result.migrated).toBe(true);
		expect(readFileSync(join(brandDir, "settings.json"), "utf-8")).toBe('{"theme":"dark"}');
		expect(result.copied).not.toContain("desktop");
		expect(result.copied).not.toContain("desktop.init-abc");
		expect(existsSync(join(brandDir, "desktop.init-abc"))).toBe(false);
		expect(readdirSync(join(brandDir, "desktop"))).toEqual(["app.db"]);
		expect(readFileSync(join(brandDir, "desktop", "app.db"), "utf-8")).toBe("desktop-owned");
	});

	// #2898 review L6: on darwin and win32 `~/.omo/Desktop` is the desktop's own folder.
	test.runIf(process.platform === "darwin" || process.platform === "win32")(
		"skips the reserved entries in any case where the volume folds case",
		() => {
			const legacy = seedLegacyAgentDir();
			mkdirSync(join(legacy, "Desktop"), { recursive: true });
			mkdirSync(join(legacy, "DESKTOP.init-abc"), { recursive: true });
			const brandDir = join(root, ".omo");

			const result = migrateEngineStateToBrandDir(legacy, brandDir);

			expect(result.copied).not.toContain("Desktop");
			expect(result.copied).not.toContain("DESKTOP.init-abc");
			expect(existsSync(join(brandDir, "desktop"))).toBe(false);
		},
	);

	test.runIf(process.platform === "linux")("copies a differently cased entry where names are case-sensitive", () => {
		const legacy = seedLegacyAgentDir();
		mkdirSync(join(legacy, "Desktop"), { recursive: true });

		expect(migrateEngineStateToBrandDir(legacy, join(root, ".omo")).copied).toContain("Desktop");
	});

	test("leaves a missing desktop home uncreated", () => {
		const legacy = seedLegacyAgentDir();
		mkdirSync(join(legacy, "desktop"), { recursive: true });
		writeFileSync(join(legacy, "desktop", "x"), "engine");
		const brandDir = join(root, ".omo");

		migrateEngineStateToBrandDir(legacy, brandDir);

		expect(existsSync(join(brandDir, "desktop"))).toBe(false);
	});

	test("does nothing when there is no engine state to copy", () => {
		const result = migrateEngineStateToBrandDir(join(root, "missing"), join(root, ".omo"));

		expect(result.migrated).toBe(false);
		expect(existsSync(join(root, ".omo"))).toBe(false);
	});
});
