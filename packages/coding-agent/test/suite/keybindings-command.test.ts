import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "../../src/core/keybindings.ts";
import { applyKeybindingsFileEdit, seedKeybindingsFile } from "../../src/modes/interactive/keybindings-command.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-keybindings-"));
	configPath = join(dir, "keybindings.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("seedKeybindingsFile", () => {
	it("writes every keybinding id when the file is missing", () => {
		const manager = new KeybindingsManager({}, configPath);

		expect(seedKeybindingsFile(configPath, manager)).toBe(true);

		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
		for (const id of Object.keys(KEYBINDINGS)) {
			expect(parsed).toHaveProperty(id);
		}
	});

	it("leaves an existing file's content and mtime untouched", () => {
		writeFileSync(configPath, '{"app.interrupt":"ctrl+g"}', "utf-8");
		const before = statSync(configPath).mtimeMs;
		const manager = new KeybindingsManager({}, configPath);

		expect(seedKeybindingsFile(configPath, manager)).toBe(false);
		expect(readFileSync(configPath, "utf-8")).toBe('{"app.interrupt":"ctrl+g"}');
		expect(statSync(configPath).mtimeMs).toBe(before);
	});
});

describe("applyKeybindingsFileEdit", () => {
	it("reloads the live manager so a rewritten binding takes effect without restart", () => {
		const manager = new KeybindingsManager({}, configPath);
		expect(manager.getKeys("app.approval.cycle")).toEqual(["shift+tab"]);
		expect(manager.getKeys("app.thinking.cycle")).toEqual([]);

		writeFileSync(
			configPath,
			JSON.stringify({
				"app.approval.cycle": [],
				"app.thinking.cycle": "shift+tab",
			}),
			"utf-8",
		);
		const result = applyKeybindingsFileEdit(configPath, manager);

		expect(result.status).toBe("reloaded");
		expect(manager.getKeys("app.approval.cycle")).toEqual([]);
		expect(manager.getKeys("app.thinking.cycle")).toEqual(["shift+tab"]);
	});

	it("refuses to reload invalid JSON and leaves the live bindings unchanged", () => {
		const manager = new KeybindingsManager({}, configPath);
		writeFileSync(configPath, "{ not valid json", "utf-8");

		const result = applyKeybindingsFileEdit(configPath, manager);

		expect(result.status).toBe("invalid");
		expect(manager.getKeys("app.thinking.cycle")).toEqual([]);
		expect(readFileSync(configPath, "utf-8")).toBe("{ not valid json");
	});
});
