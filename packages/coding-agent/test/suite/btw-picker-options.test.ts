import { describe, expect, it } from "vitest";
import { buildBtwPickerOptions, validateBtwPickerChoice } from "../../src/core/extensions/builtin/btw/picker.ts";
import type { BtwSessionCatalog } from "../../src/core/extensions/builtin/btw/session-catalog.ts";

function catalog(): BtwSessionCatalog {
	return {
		parentSessionPath: "/sessions/main.jsonl",
		main: {
			id: "main",
			path: "/sessions/main.jsonl",
			cwd: "/repo",
			name: "Main task",
			modified: new Date("2026-08-23T00:00:00.000Z"),
		},
		currentSide: undefined,
		sides: [
			{
				id: "side-one-abcdef",
				path: "/sessions/side-1.jsonl",
				cwd: "/repo",
				name: "BTW #1: duplicate summary",
				modified: new Date("2026-08-23T00:00:01.000Z"),
				metadata: {
					version: 1,
					parentSessionPath: "/sessions/main.jsonl",
					parentSessionId: "main",
					ordinal: 1,
					summary: "duplicate summary",
					createdAt: "2026-08-23T00:00:01.000Z",
				},
			},
			{
				id: "side-two-uvwxyz",
				path: "/sessions/side-2.jsonl",
				cwd: "/repo",
				name: "BTW #2: duplicate summary",
				modified: new Date("2026-08-23T00:00:02.000Z"),
				metadata: {
					version: 1,
					parentSessionPath: "/sessions/main.jsonl",
					parentSessionId: "main",
					ordinal: 2,
					summary: "duplicate summary",
					createdAt: "2026-08-23T00:00:02.000Z",
				},
			},
		],
		skippedPaths: [],
	};
}

describe("buildBtwPickerOptions", () => {
	it("orders Main, numbered retained sides, and New BTW with unambiguous labels", () => {
		// Given
		const loaded = catalog();

		// When
		const options = buildBtwPickerOptions(loaded, "/sessions/side-1.jsonl");

		// Then
		expect(options.map((option) => option.label)).toEqual([
			"Main — Main task",
			"BTW #1 — duplicate summary (current)",
			"BTW #2 — duplicate summary",
			"New BTW",
		]);
		expect(options.map((option) => option.choice)).toEqual([
			{ type: "session", sessionPath: "/sessions/main.jsonl", sessionId: "main" },
			{ type: "session", sessionPath: "/sessions/side-1.jsonl", sessionId: "side-one-abcdef" },
			{ type: "session", sessionPath: "/sessions/side-2.jsonl", sessionId: "side-two-uvwxyz" },
			{ type: "new", parentSessionPath: "/sessions/main.jsonl", parentSessionId: "main" },
		]);
	});

	it("disambiguates cloned sides with identical ordinals and summaries", () => {
		// Given
		const loaded = catalog();
		loaded.sides[1]!.metadata.ordinal = loaded.sides[0]!.metadata.ordinal;
		loaded.sides[1]!.metadata.summary = loaded.sides[0]!.metadata.summary;

		// When
		const options = buildBtwPickerOptions(loaded, loaded.parentSessionPath);
		const sideOptions = options.filter(
			(option) => option.choice.type === "session" && option.choice.sessionPath !== loaded.parentSessionPath,
		);

		// Then
		expect(new Set(sideOptions.map((option) => option.label)).size).toBe(2);
		expect(sideOptions.map((option) => option.choice)).toEqual([
			{ type: "session", sessionPath: "/sessions/side-1.jsonl", sessionId: "side-one-abcdef" },
			{ type: "session", sessionPath: "/sessions/side-2.jsonl", sessionId: "side-two-uvwxyz" },
		]);
	});

	it("keeps retained sides selectable when the parent file is missing", () => {
		// Given
		const loaded = catalog();
		loaded.main = undefined;

		// When
		const options = buildBtwPickerOptions(loaded, "/sessions/side-2.jsonl");

		// Then
		expect(options.map((option) => option.label)).toEqual([
			"BTW #1 — duplicate summary",
			"BTW #2 — duplicate summary (current)",
		]);
		expect(options.some((option) => option.choice.type === "new")).toBe(false);
	});
});

describe("validateBtwPickerChoice", () => {
	it("rejects a selected session or New BTW parent that disappeared", async () => {
		// Given
		const identify = async (path: string) => (path === "/sessions/main.jsonl" ? "main" : undefined);

		// When
		const staleSide = await validateBtwPickerChoice(
			{ type: "session", sessionPath: "/sessions/stale.jsonl", sessionId: "stale" },
			identify,
		);
		const staleParent = await validateBtwPickerChoice(
			{ type: "new", parentSessionPath: "/sessions/deleted-main.jsonl", parentSessionId: "deleted-main" },
			identify,
		);
		const replacedMain = await validateBtwPickerChoice(
			{ type: "session", sessionPath: "/sessions/main.jsonl", sessionId: "old-main" },
			identify,
		);
		const main = await validateBtwPickerChoice(
			{ type: "session", sessionPath: "/sessions/main.jsonl", sessionId: "main" },
			identify,
		);

		// Then
		expect(staleSide).toBe(false);
		expect(staleParent).toBe(false);
		expect(replacedMain).toBe(false);
		expect(main).toBe(true);
	});
});
