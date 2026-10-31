import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import reasoningExtension from "../../../src/core/extensions/builtin/reasoning/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("3178 changing thinking levels without saving the startup default", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		["/reasoning off", "high", "off"],
		["/reasoning on", "off", "high"],
		["/efforts low", "high", "low"],
		["cycle key / RPC cycle_thinking_level", "low", "medium"],
		["session / RPC set_thinking_level", "high", "low"],
	] satisfies readonly (readonly [string, ThinkingLevel, ThinkingLevel])[])(
		"keeps config bytes after %s actually changes the level",
		async (path, initial, expected) => {
			const harness = await createHarness({
				fileSettings: true,
				models: [{ id: "graded", reasoning: true }],
				settings: {
					theme: "dark",
					defaultThinkingLevel: "minimal",
					modelLastOnThinkingLevels: { "faux/graded": "high" },
				},
				extensionFactories: [reasoningExtension],
			});
			harnesses.push(harness);
			harness.session.setSessionThinkingLevel(initial);
			const settingsPath = join(harness.tempDir, "agent", "settings.json");
			const before = readFileSync(settingsPath, "utf8");

			if (path.startsWith("/")) await harness.session.prompt(path);
			else if (path.startsWith("cycle")) harness.session.cycleThinkingLevel();
			else harness.session.setThinkingLevel(expected);
			await harness.settingsManager.flush();

			expect(harness.session.thinkingLevel).toBe(expected);
			expect(harness.session.thinkingLevel).not.toBe(initial);
			expect(readFileSync(settingsPath, "utf8")).toBe(before);
			const state = JSON.parse(readFileSync(join(harness.tempDir, "agent", "state.json"), "utf8"));
			expect(state.modelThinkingLevels).toEqual({ "faux/graded": expected });
			expect(state.modelLastOnThinkingLevels).toEqual({ "faux/graded": expected === "off" ? initial : expected });
		},
	);

	it.each([
		["graded", true, "low", "low"],
		["plain", false, "off", "high"],
	] as const)("preserves the explicit thinking save contract on %s models", async (id, reasoning, level, saved) => {
		const harness = await createHarness({
			fileSettings: true,
			models: [{ id, reasoning }],
			settings: { defaultThinkingLevel: "high" },
		});
		harnesses.push(harness);
		harness.session.setSessionThinkingLevel("high");
		const select: unknown = Reflect.get(InteractiveMode.prototype, "selectThinkingLevel");
		if (typeof select !== "function") throw new Error("Missing thinking selector action");
		select.call(
			{
				session: harness.session,
				settingsManager: harness.settingsManager,
				footer: { invalidate: () => {} },
				updateEditorBorderColor: () => {},
				showStatus: () => {},
				showError: (message: string) => {
					throw new Error(message);
				},
			},
			level,
			true,
		);
		await harness.settingsManager.flush();

		expect(harness.session.thinkingLevel).toBe(level);
		expect(
			JSON.parse(readFileSync(join(harness.tempDir, "agent", "settings.json"), "utf8")).defaultThinkingLevel,
		).toBe(saved);
	});
});
