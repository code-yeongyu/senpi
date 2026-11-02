import { describe, expect, it } from "vitest";
import {
	catalogChangelogEntry,
	catalogChangelogFragment,
	diffOpenGatewayCatalogs,
	hasCatalogChanges,
	renderCatalogDiffMarkdown,
} from "../scripts/opengateway-catalog-diff.ts";

function catalog(...rows: { id: string; contextWindow: number; cost?: { input: number } }[]) {
	return {
		"openai-completions": Object.fromEntries(rows.map((row) => [`chat:${row.id}`, { name: row.id, ...row }])),
	};
}

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

	it("records the refresh as an AI changelog fragment", () => {
		const diff = diffOpenGatewayCatalogs(committed, regenerated);
		const entry = catalogChangelogEntry(diff);
		expect(catalogChangelogFragment(diff)).toBe(
			`<!-- changes-log: packages/ai/CHANGELOG.md -->\n### Changed\n${entry}\n`,
		);
		expect(entry).toContain("adds `z-ai/glm-6`");
		expect(entry).toContain("removes `openai/o1-preview`");
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
});
