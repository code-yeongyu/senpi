import { Script } from "node:vm";
import * as ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { READ_FOLD_SETTINGS, selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";
import { createDefaultReadSummary, createSegmentedReadView } from "../../src/harness/utils/segmented-read-view.ts";
import { adversarialSignatures, signatureSource } from "./fixtures/read-summary/adversarial-signatures.ts";
import { annotate, retainedSourceExact } from "./fixtures/read-summary/oracle.ts";
import { validBoundaries } from "./fixtures/read-summary/scorer.ts";

describe("declaration boundary safety (#1639)", () => {
	it.each(adversarialSignatures)("retains $name through its body boundary", (fixture) => {
		// Given valid, independently written signatures repeated past the default-read minimum.
		const signature = signatureSource(fixture);
		if (fixture.language === "js") expect(() => new Script(signature)).not.toThrow();
		const syntax = ts.transpileModule(signature, {
			reportDiagnostics: true,
			compilerOptions: { target: ts.ScriptTarget.Latest },
		});
		expect(syntax.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
		const declarations = Array.from({ length: 20 }, (_, i) =>
			signature.replace(/\b(Example|choose|value)\b/g, `$1${i}`),
		);
		const text = declarations.join("\n");
		const path = `input.${fixture.language}`;
		const parsed = selectedReadFolder.fold({ path, text, settings: READ_FOLD_SETTINGS });
		// When inspecting all candidate ranges, including ranges spanning the protected interval.
		const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
		for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
		for (let i = 0; i < declarations.length; i++) {
			const start = i * signature.split("\n").length + 1;
			const end = start + fixture.header.split("\n").length + 5;
			expect(ranges.filter((r) => r.startLine <= end && r.endLine >= start)).toEqual([]);
		}
		// Then the direct candidate and the actual default adapter preserve every complete declaration.
		const view = createSegmentedReadView({ text, parsed });
		const candidate = view.status === "summary" ? view.rendered.text : text;
		const actual =
			createDefaultReadSummary({ path, text, folder: selectedReadFolder, truncated: false })?.text ?? text;
		for (const declaration of declarations) {
			expect(candidate).toContain(declaration);
			expect(actual).toContain(declaration);
		}
	});

	it.each(adversarialSignatures)("oracle rejects a byte-faithful omission of $name", (fixture) => {
		// Given exactly numbered signature text and an independently fabricated omission.
		const source = signatureSource(fixture);
		const start = fixture.header.split("\n").length + 1;
		const end = start + 4;
		const folds = [{ start, end }];
		const text = `${fixture.header}\n…\n${fixture.tail}\n\noffset=${start} limit=5`;
		const candidate = { text, folds, reason: "adversarial", scanned_folds: 1 };
		// When verifying retained bytes, they really are faithful; safety must come from the source oracle.
		expect(retainedSourceExact(source, candidate)).toBe(true);
		expect(validBoundaries({ source, folds, allowed: annotate(source, fixture.language), retainedExact: true })).toBe(
			false,
		);
	});

	it("rejects enclosing folds that overlap a nested declaration header", () => {
		// Given an outer implementation containing a protected nested class signature.
		const source = `function outer() {\n${signatureSource(adversarialSignatures[0])}\nreturn Example;\n}`;
		const parsed = selectedReadFolder.fold({ path: "input.js", text: source, settings: READ_FOLD_SETTINGS });
		const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
		for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
		// Then neither an enclosing body nor the heritage object may omit any signature line.
		expect(ranges.filter((r) => r.startLine <= 8 && r.endLine >= 2)).toEqual([]);
		expect(annotate(source, "js").filter((r) => r.start <= 8 && r.end >= 2)).toEqual([]);
	});
});
