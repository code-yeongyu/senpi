import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { referenceSchema } from "./reference.ts";
import { sha256 } from "./scorer.ts";

type TokenizerIdentity = z.infer<typeof referenceSchema>["tokenizer"];

/** Verify the bytes that will execute, not just the historical receipt we report. */
export function verifyTokenizer(root: string, expected: TokenizerIdentity): void {
	const directory = join(root, "node_modules/gpt-tokenizer");
	const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	if (
		expected.name !== "gpt-tokenizer" ||
		expected.encoding !== "o200k_base" ||
		pkg.name !== expected.name ||
		pkg.version !== expected.version
	)
		throw new Error("tokenizer_identity_drift");
	for (const [path, hash] of Object.entries(expected.files)) {
		if (sha256(readFileSync(join(directory, path))) !== hash) throw new Error("tokenizer_identity_drift");
	}
	const hash = createHash("sha256");
	// Preserve the original capture's filename hashing convention exactly.
	const files = readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => `${entry.parentPath.slice(directory.length + 1)}/${entry.name}`)
		.sort();
	for (const path of files) hash.update(path).update(readFileSync(`${directory}/${path}`));
	if (hash.digest("hex") !== expected.packageSha256) throw new Error("tokenizer_identity_drift");
}
