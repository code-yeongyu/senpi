import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every GPT-6 Astra series entry ships one project-wide context window.
 *
 * The generator is the single source of truth (`scripts/generate-models.ts`),
 * but passthrough catalogs (opencode, openrouter, github-copilot,
 * vercel-ai-gateway) previously inherited the upstream 1,050,000 declaration
 * while the first-party OpenAI catalogs carried the 922,000 input cap. A user
 * therefore saw a different Astra budget depending on which provider routed the
 * request. This suite pins the whole series to one number across every catalog
 * so a regenerated catalog cannot silently reintroduce the split.
 */
const ASTRA_CONTEXT_WINDOW = 600_000;
const dataDirectory = fileURLToPath(new URL("../src/providers/data/", import.meta.url));

type CatalogEntry = { id?: unknown; contextWindow?: unknown };
type AstraEntry = { file: string; api: string; id: string; contextWindow: unknown };

function collectAstraEntries(): AstraEntry[] {
	const entries: AstraEntry[] = [];
	for (const file of readdirSync(dataDirectory)
		.filter((name) => name.endsWith(".json"))
		.sort()) {
		const parsed = JSON.parse(readFileSync(`${dataDirectory}${file}`, "utf8")) as Record<
			string,
			Record<string, CatalogEntry>
		>;
		for (const [api, models] of Object.entries(parsed)) {
			if (!models || typeof models !== "object") continue;
			for (const [id, model] of Object.entries(models)) {
				if (!id.includes("gpt-6-astra")) continue;
				entries.push({ file, api, id, contextWindow: model?.contextWindow });
			}
		}
	}
	return entries;
}

describe("GPT-6 Astra series catalog context window", () => {
	it("declares the same context window for every Astra entry in every provider catalog", () => {
		const entries = collectAstraEntries();
		expect(entries.length, "generated catalogs should ship Astra entries").toBeGreaterThan(0);
		const offenders = entries
			.filter((entry) => entry.contextWindow !== ASTRA_CONTEXT_WINDOW)
			.map((entry) => `${entry.file}:${entry.api}/${entry.id}=${String(entry.contextWindow)}`)
			.sort();
		expect(offenders, "Astra entries must all declare the series context window").toEqual([]);
	});

	it("keeps every provider catalog that ships Astra covered", () => {
		const files = [...new Set(collectAstraEntries().map((entry) => entry.file))].sort();
		expect(files).toEqual([
			"azure-openai-responses.json",
			"github-copilot.json",
			"openai-codex.json",
			"openai.json",
			"opencode.json",
			"openrouter.json",
			"vercel-ai-gateway.json",
		]);
	});
});
