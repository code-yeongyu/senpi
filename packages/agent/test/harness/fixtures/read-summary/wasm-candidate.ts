import { selectedReadFolder } from "../../../../src/harness/utils/read-folders/index.ts";
import { loadTreeSitterFolder } from "../../../../src/harness/utils/read-folders/tree-sitter/engine.ts";
import type { TreeSitterLanguage } from "../../../../src/harness/utils/read-folders/tree-sitter/syntax.ts";
import type { ReadFolder } from "../../../../src/harness/utils/read-folders/types.ts";
import { type EngineCandidate, engineCandidate } from "./engine-candidate.ts";

const evaluated: readonly TreeSitterLanguage[] = ["ts", "tsx", "js"];
const folders = new Map<TreeSitterLanguage, Promise<ReadFolder | undefined>>();

export function isWasmCandidateLanguage(language: string): language is TreeSitterLanguage {
	return (evaluated as readonly string[]).includes(language);
}

/** The grammar candidate under the shipped view, measured exactly like the heuristic candidate. */
export async function wasmCandidate(
	path: string,
	source: string,
	language: string,
): Promise<EngineCandidate | undefined> {
	if (!isWasmCandidateLanguage(language)) return undefined;
	const pending =
		folders.get(language) ??
		loadTreeSitterFolder(language, { fallback: selectedReadFolder, cache: false }).catch(() => undefined);
	folders.set(language, pending);
	const folder = await pending;
	return folder && engineCandidate(folder, path, source);
}
