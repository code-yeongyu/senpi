#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Extracted from codex commit bb83eec825b74aaf06f74650d2c004b0629dd19a.
const CODEX_COMMIT_SHA = "bb83eec825b74aaf06f74650d2c004b0629dd19a";
const CODEX_ROOT = "/Users/yeongyu/local-workspaces/codex";
const TOOL_SOURCE_PATH = path.join(CODEX_ROOT, "codex-rs/tools/src/apply_patch_tool.rs");
const GRAMMAR_PATH = path.join(CODEX_ROOT, "codex-rs/tools/src/tool_apply_patch.lark");
const OUTPUT_PATH = path.join(
	process.cwd(),
	"packages/coding-agent/test/goldens/codex-apply-patch-schema.json",
);

function extractRustRawString(source, constantName) {
	const expression = new RegExp(`const ${constantName}: &str = r#"([\\s\\S]*?)"#;`);
	const match = source.match(expression);
	if (!match || typeof match[1] !== "string") {
		throw new Error(`Unable to extract ${constantName} from ${TOOL_SOURCE_PATH}`);
	}
	return match[1];
}

async function main() {
	const source = await readFile(TOOL_SOURCE_PATH, "utf-8");
	const grammar = await readFile(GRAMMAR_PATH, "utf-8");
	const jsonDescription = extractRustRawString(source, "APPLY_PATCH_JSON_TOOL_DESCRIPTION");

	const golden = {
		description:
			"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
		grammar,
		grammarLength: grammar.length,
		jsonDescription,
		codexCommitSha: CODEX_COMMIT_SHA,
	};

	await writeFile(OUTPUT_PATH, `${JSON.stringify(golden, null, 2)}\n`, "utf-8");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
