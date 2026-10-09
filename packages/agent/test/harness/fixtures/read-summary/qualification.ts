import { writeFileSync } from "node:fs";
import { READ_FOLD_SETTINGS, selectedReadFolder } from "../../../../src/harness/utils/read-folders/index.ts";
import { prepareReadFolder } from "../../../../src/harness/utils/read-folders/prepare.ts";
import type { ReadFolder } from "../../../../src/harness/utils/read-folders/types.ts";
import {
	createDefaultReadSummary,
	createSegmentedReadView,
} from "../../../../src/harness/utils/segmented-read-view.ts";
import { enumerateBoundaries } from "./adversarial-enumeration.ts";
import { adversarialSignatures, signatureSource } from "./adversarial-signatures.ts";
import { annotate } from "./oracle.ts";
import { typescriptOracle } from "./oracle-typescript.ts";
import { sha256, validBoundaries } from "./scorer.ts";

/** Qualify the folders the reader actually uses for these languages, not a superseded engine. */
async function shippedFolders(): Promise<Record<"ts" | "js", ReadFolder>> {
	const [ts, js] = await Promise.all([
		prepareReadFolder("input.ts", selectedReadFolder),
		prepareReadFolder("input.js", selectedReadFolder),
	]);
	return { ts: ts ?? selectedReadFolder, js: js ?? selectedReadFolder };
}

export async function qualifyEnumeration(path: string) {
	const folders = await shippedFolders();
	const receipt = enumerateBoundaries((language) => folders[language]);
	const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
	writeFileSync(path, bytes);
	if (receipt.counterexamples.length) throw new Error("adversarial_enumeration_failed");
	return { ...receipt, sha256: sha256(bytes) };
}

/** Supplemental safety cases have no comparator/token score and are never counted as real corpus files. */
export async function qualifySignatures() {
	const folders = await shippedFolders();
	return adversarialSignatures.map((fixture) => {
		const declaration = signatureSource(fixture);
		const source = Array.from({ length: 20 }, (_, i) =>
			declaration.replace(/\b(Example|choose|value)\b/g, `$1${i}`),
		).join("\n");
		const path = `boundary-${fixture.name}.${fixture.language}`;
		const parsed = folders[fixture.language === "js" ? "js" : "ts"].fold({
			path,
			text: source,
			settings: READ_FOLD_SETTINGS,
		});
		const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
		for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
		const folds = ranges.map((range) => ({ start: range.startLine, end: range.endLine }));
		const oracle = typescriptOracle(source, fixture.language);
		const valid = folds.every((fold) =>
			validBoundaries({
				source,
				folds: [fold],
				allowed: oracle.allowed,
				protected: oracle.protected,
				retainedExact: true,
			}),
		);
		const view = createSegmentedReadView({ text: source, parsed });
		const output =
			createDefaultReadSummary({
				path,
				text: source,
				folder: folders[fixture.language === "js" ? "js" : "ts"],
				truncated: false,
			})?.text ?? source;
		return {
			id: path,
			language: fixture.language,
			source,
			source_sha256: sha256(source),
			allowed: annotate(source, fixture.language),
			protected: oracle.protected,
			discovered: folds,
			valid,
			parse_status: parsed.status,
			candidate_sha256: sha256(view.status === "summary" ? view.rendered.text : source),
			default_read_sha256: sha256(output),
		};
	});
}
