import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packagedAssetDirectory } from "../../../../src/harness/utils/read-folders/tree-sitter/grammar-assets.ts";
import { sha256 } from "./scorer.ts";

type Provenance = {
	readonly runtime: {
		readonly file: string;
		readonly package: string;
		readonly version: string;
		readonly sha256: string;
	};
	readonly grammars: readonly {
		readonly language: string;
		readonly file: string;
		readonly package: string;
		readonly version: string;
		readonly sha256: string;
	}[];
};

export function treeSitterProvenance(): Provenance {
	return JSON.parse(readFileSync(join(packagedAssetDirectory, "provenance.json"), "utf8"));
}

/** Shipped WebAssembly artifacts with their measured on-disk size, recorded in the selection receipt. */
export function treeSitterAssets() {
	const provenance = treeSitterProvenance();
	return [
		{ kind: "runtime", language: null, ...provenance.runtime },
		...provenance.grammars.map((grammar) => ({ kind: "grammar", ...grammar })),
	].map((artifact) => {
		const path = join(packagedAssetDirectory, artifact.file);
		const bytes = statSync(path).size;
		return {
			kind: artifact.kind,
			language: "language" in artifact ? artifact.language : null,
			file: artifact.file,
			package: artifact.package,
			version: artifact.version,
			bytes,
			sha256: sha256(readFileSync(path)),
			declared_sha256: artifact.sha256,
		};
	});
}
