import { describe, expect, it } from "vitest";
import { buildCursorSystemPromptJsons } from "../src/api/cursor-agent.ts";
import { CURSOR_COMPOSER_PROMPT, isCursorComposerModel } from "../src/cursor/composer-prompt.ts";
import aliasData from "../src/cursor/cursor-variant-aliases.json" with { type: "json" };

const catalogIds = Object.keys((aliasData as { aliases: Record<string, unknown> }).aliases);
const composerIds = catalogIds.filter((id) => id.toLowerCase().includes("composer"));
const nonComposerIds = catalogIds.filter((id) => !id.toLowerCase().includes("composer"));

function contentsOf(jsons: readonly string[]): string[] {
	return jsons.map((json) => (JSON.parse(json) as { content: string }).content);
}

describe("isCursorComposerModel", () => {
	it("matches every composer id the live catalog capture serves", () => {
		expect(composerIds.length).toBeGreaterThan(0);
		expect(composerIds.filter((id) => !isCursorComposerModel(id))).toEqual([]);
	});

	it("leaves every non-composer catalog id alone", () => {
		expect(nonComposerIds.filter((id) => isCursorComposerModel(id))).toEqual([]);
	});

	it("keeps cursor's resold first-party kimi models out of the composer family", () => {
		for (const id of ["kimi-k2.7-code", "kimi-k3-high", "kimi-k3-low"]) {
			expect(isCursorComposerModel(id), `${id} must not be treated as composer`).toBe(false);
		}
	});

	it("matches provider-qualified and future composer ids", () => {
		for (const id of ["cursor/composer-2.5", "composer-3", "composer-2.7-thinking-max"]) {
			expect(isCursorComposerModel(id), `${id} must be treated as composer`).toBe(true);
		}
	});
});

describe("buildCursorSystemPromptJsons composer prefix", () => {
	it("pins the composer prompt ahead of the host prompt for composer models", () => {
		const contents = contentsOf(buildCursorSystemPromptJsons("Host system prompt.", "composer-2.6"));
		expect(contents).toEqual([CURSOR_COMPOSER_PROMPT, "Host system prompt."]);
	});

	it("still emits the composer prompt when the host prompt is absent", () => {
		const contents = contentsOf(buildCursorSystemPromptJsons(undefined, "composer-2.5-fast"));
		expect(contents[0]).toBe(CURSOR_COMPOSER_PROMPT);
		expect(contents).toHaveLength(2);
	});

	it("leaves non-composer models on the untouched single-blob shape", () => {
		const contents = contentsOf(buildCursorSystemPromptJsons("Host system prompt.", "claude-4.5-sonnet"));
		expect(contents).toEqual(["Host system prompt."]);
	});

	it("keeps the pre-existing shape when no model id is supplied", () => {
		const contents = contentsOf(buildCursorSystemPromptJsons("Host system prompt."));
		expect(contents).toEqual(["Host system prompt."]);
	});

	it("emits each system message as its own role-tagged blob", () => {
		const jsons = buildCursorSystemPromptJsons("Host system prompt.", "composer-2.6-lite-medium-fast");
		for (const json of jsons) {
			expect((JSON.parse(json) as { role: string }).role).toBe("system");
		}
	});
});
