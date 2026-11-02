import { describe, expect, it } from "vitest";
import { READ_FOLD_SETTINGS, selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";
import { loadTreeSitterFolder } from "../../src/harness/utils/read-folders/tree-sitter/engine.ts";
import type { ReadFolder } from "../../src/harness/utils/read-folders/types.ts";
import { createSegmentedReadView } from "../../src/harness/utils/segmented-read-view.ts";
import { enumerateBoundaries } from "./fixtures/read-summary/adversarial-enumeration.ts";
import { adversarialSignatures, signatureSource } from "./fixtures/read-summary/adversarial-signatures.ts";
import { typescriptOracle } from "./fixtures/read-summary/oracle-typescript.ts";
import { overlaps, validBoundaries } from "./fixtures/read-summary/scorer.ts";

async function folders(): Promise<Record<"ts" | "js", ReadFolder>> {
	const [ts, js] = await Promise.all([
		loadTreeSitterFolder("ts", { fallback: selectedReadFolder, cache: false }),
		loadTreeSitterFolder("js", { fallback: selectedReadFolder, cache: false }),
	]);
	if (!ts || !js) throw new Error("grammar unavailable");
	return { ts, js };
}

describe("tree-sitter boundary safety (#1685)", () => {
	it("emits no counterexample across the adversarial grammar under the same oracle", async () => {
		// Given the enumerated adversarial programs that qualify the shipped heuristic.
		const engines = await folders();
		// When every program is folded by the grammar engine instead.
		const receipt = enumerateBoundaries((language) => engines[language]);
		// Then the source oracle rejects nothing it emitted, and it still emits real ranges.
		expect(receipt.counterexamples).toEqual([]);
		expect(receipt.emittedRanges).toBeGreaterThan(0);
		expect(receipt.protectedPrograms).toBeGreaterThan(0);
	});

	it.each(adversarialSignatures)("retains $name through its body boundary", async (fixture) => {
		// Given twenty repetitions of an independently written declaration.
		const engines = await folders();
		const signature = signatureSource(fixture);
		const declarations = Array.from({ length: 20 }, (_, index) =>
			signature.replace(/\b(Example|choose|value)\b/g, `$1${index}`),
		);
		const text = declarations.join("\n");
		const path = `input.${fixture.language}`;
		const parsed = engines[fixture.language === "js" ? "js" : "ts"].fold({
			path,
			text,
			settings: READ_FOLD_SETTINGS,
		});
		const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
		for (let index = 0; index < ranges.length; index++) ranges.push(...ranges[index].children);
		const oracle = typescriptOracle(text, fixture.language);
		// When inspecting every emitted range, then no protected header line is omitted.
		for (const range of ranges) {
			const fold = { start: range.startLine, end: range.endLine };
			expect(
				oracle.protected.some((header) => overlaps(fold, header)),
				JSON.stringify(fold),
			).toBe(false);
			expect(validBoundaries({ source: text, folds: [fold], ...oracle, retainedExact: true })).toBe(true);
		}
		// Then the rendered view keeps every complete declaration.
		const view = createSegmentedReadView({ text, parsed });
		const rendered = view.status === "summary" ? view.rendered.text : text;
		for (const declaration of declarations) expect(rendered).toContain(declaration);
	});
});
