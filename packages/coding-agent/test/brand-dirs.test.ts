import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	test("does nothing when there is no engine state to copy", () => {
		const result = migrateEngineStateToBrandDir(join(root, "missing"), join(root, ".omo"));

		expect(result.migrated).toBe(false);
		expect(existsSync(join(root, ".omo"))).toBe(false);
	});
});
