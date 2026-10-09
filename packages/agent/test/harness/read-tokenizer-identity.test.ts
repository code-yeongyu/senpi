import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tokenize } from "./fixtures/read-summary/reference.ts";
import { sha256 } from "./fixtures/read-summary/scorer.ts";

function tokenizerFixture() {
	const root = mkdtempSync(join(tmpdir(), "read-tokenizer-"));
	const packageRoot = join(root, "node_modules/gpt-tokenizer");
	const files = {
		"package.json": '{"name":"gpt-tokenizer","version":"4.0.0","type":"module"}',
		"esm/encoding/o200k_base.js": "export const encode = text => Array.from(text);\n",
		"esm/bpeRanks/o200k_base.js": "export default [];\n",
	};
	for (const [name, bytes] of Object.entries(files)) {
		mkdirSync(dirname(join(packageRoot, name)), { recursive: true });
		writeFileSync(join(packageRoot, name), bytes);
	}
	// Historical receipt hashing prefixes root-level filenames with '/', not nested paths.
	const hash = createHash("sha256");
	hash.update("/package.json").update(files["package.json"]);
	hash.update("esm/bpeRanks/o200k_base.js").update(files["esm/bpeRanks/o200k_base.js"]);
	hash.update("esm/encoding/o200k_base.js").update(files["esm/encoding/o200k_base.js"]);
	return {
		root,
		packageRoot,
		identity: {
			name: "gpt-tokenizer",
			version: "4.0.0",
			encoding: "o200k_base",
			exact: true as const,
			files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
			packageSha256: hash.digest("hex"),
			lockIntegrity: "fixture-only",
		},
	};
}

describe("frozen tokenizer execution identity (#1639)", () => {
	it("tokenizes only after verifying the installation against the receipt", () => {
		const { root, identity } = tokenizerFixture();
		try {
			expect(tokenize(root, ["ab", ""], identity)).toEqual([2, 0]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it.each([
		["package.json", '{"name":"gpt-tokenizer","version":"4.0.1","type":"module"}'],
		["esm/encoding/o200k_base.js", 'throw new Error("drift_executed"); export const encode = () => [];'],
		["esm/bpeRanks/o200k_base.js", "export default [123];"],
		["esm/other-implementation.js", "export const drift = true;"],
	])("rejects changed bytes in %s before loading the tokenizer", (file, bytes) => {
		const { root, packageRoot, identity } = tokenizerFixture();
		try {
			writeFileSync(join(packageRoot, file), bytes);
			expect(() => tokenize(root, ["ab"], identity)).toThrow("tokenizer_identity_drift");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
