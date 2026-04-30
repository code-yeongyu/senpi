import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
} from "../../../src/core/extensions/builtin/gpt-apply-patch.js";

type CodexApplyPatchGolden = {
	description: string;
	grammar: string;
	grammarLength: number;
	jsonDescription: string;
	codexCommitSha: string;
};

async function readGolden(): Promise<CodexApplyPatchGolden> {
	const goldenPath = path.resolve(process.cwd(), "test/goldens/codex-apply-patch-schema.json");
	return JSON.parse(await readFile(goldenPath, "utf-8")) as CodexApplyPatchGolden;
}

describe("codex apply_patch schema parity", () => {
	it("matches codex freeform description and grammar byte for byte", async () => {
		// given
		const golden = await readGolden();

		// when
		const description = APPLY_PATCH_FREEFORM_DESCRIPTION;
		const grammar = APPLY_PATCH_LARK_GRAMMAR;

		// then
		expect(description).toBe(golden.description);
		expect(grammar).toBe(golden.grammar);
		expect(grammar.length).toBe(golden.grammarLength);
		expect(golden.codexCommitSha).toMatch(/^[0-9a-f]{40}$/);
	});
});
