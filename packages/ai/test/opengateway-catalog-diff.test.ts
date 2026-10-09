import { describe, expect, it } from "vitest";
import {
	catalogChangelogEntry,
	diffOpenGatewayCatalogs,
	hasCatalogChanges,
	insertUnreleasedChangedEntry,
	renderCatalogDiffMarkdown,
} from "../scripts/opengateway-catalog-diff.ts";

function catalog(...rows: { id: string; contextWindow: number; cost?: { input: number } }[]) {
	return {
		"openai-completions": Object.fromEntries(rows.map((row) => [`chat:${row.id}`, { name: row.id, ...row }])),
	};
}

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

### Changed

### Fixed

- An existing fix.

## [2026.10.1] - 2026-10-01

### Changed

- A released change.
`;

describe("OpenGateway refresh PR summary", () => {
	const committed = catalog(
		{ id: "moonshotai/kimi-k3", contextWindow: 1048576 },
		{ id: "openai/o1-preview", contextWindow: 128000 },
	);
	const regenerated = catalog(
		{ id: "moonshotai/kimi-k3", contextWindow: 1000000 },
		{ id: "z-ai/glm-6", contextWindow: 1000000, cost: { input: 1 } },
	);

	it("names every added, removed, and changed model for the reviewer", () => {
		const diff = diffOpenGatewayCatalogs(committed, regenerated);

		const markdown = renderCatalogDiffMarkdown(diff);

		expect(markdown).toContain("`z-ai/glm-6`");
		expect(markdown).toContain("### Removed\n\n- `openai/o1-preview`");
		expect(markdown).toContain("`moonshotai/kimi-k3`: contextWindow: 1048576 -> 1000000");
	});

	it("records the refresh as an Unreleased change without touching released sections", () => {
		const entry = catalogChangelogEntry(diffOpenGatewayCatalogs(committed, regenerated));

		const updated = insertUnreleasedChangedEntry(CHANGELOG, entry);

		expect(updated).toContain(`### Changed\n\n${entry}\n\n### Fixed`);
		expect(updated.slice(updated.indexOf("## [2026.10.1]"))).toBe(
			CHANGELOG.slice(CHANGELOG.indexOf("## [2026.10.1]")),
		);
		expect(entry).toContain("adds `z-ai/glm-6`");
		expect(entry).toContain("removes `openai/o1-preview`");
	});

	it("puts a new entry above existing Unreleased changes", () => {
		const withEntries = CHANGELOG.replace(
			"### Changed\n\n### Fixed",
			"### Changed\n\n- An earlier change.\n\n### Fixed",
		);

		const updated = insertUnreleasedChangedEntry(withEntries, "- The refresh.");

		expect(updated).toContain("### Changed\n\n- The refresh.\n- An earlier change.\n\n### Fixed");
	});

	it("reports a change that only touches request compatibility", () => {
		const withCompat = (strict: boolean) => ({
			"openai-completions": { "chat:z-ai/glm-6": { id: "z-ai/glm-6", compat: { supportsStrictMode: strict } } },
		});

		const diff = diffOpenGatewayCatalogs(withCompat(true), withCompat(false));

		expect(hasCatalogChanges(diff)).toBe(true);
		expect(renderCatalogDiffMarkdown(diff)).toContain("compat:");
	});

	it("reports no change when the regenerated catalog matches the committed one", () => {
		expect(hasCatalogChanges(diffOpenGatewayCatalogs(committed, committed))).toBe(false);
	});

	it("refuses to write a CHANGELOG that has no Unreleased Changed section", () => {
		expect(() => insertUnreleasedChangedEntry("# Changelog\n\n## [2026.10.1]\n\n### Changed\n", "- x")).toThrow(
			/no ### Changed section under ## \[Unreleased\]/,
		);
	});
});
