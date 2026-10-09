import assert from "node:assert/strict";
import { createReadTool } from "../../../../../coding-agent/src/core/tools/read.ts";
import { isReadSummaryPath, selectedReadFolder } from "../../../../src/harness/utils/read-folders/index.ts";
import { prepareReadFolder } from "../../../../src/harness/utils/read-folders/prepare.ts";
import { type EngineCandidate, engineCandidate } from "./engine-candidate.ts";

/** The dependency-free scan, measured whatever the frozen selection currently binds. */
export function heuristicCandidate(path: string, source: string): EngineCandidate {
	return engineCandidate(selectedReadFolder, path, source);
}

/** Measure the folder the reader really uses for this path and check the actual default read. */
export async function productionCandidate(
	cwd: string,
	path: string,
	source: string,
): Promise<EngineCandidate & { readonly defaultReadText: string; readonly engineId: string }> {
	const folder = (await prepareReadFolder(path, selectedReadFolder)) ?? selectedReadFolder;
	const candidate = engineCandidate(folder, path, source);
	const result = await createReadTool(cwd).execute("production-candidate", { path });
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	if (candidate.folds.length)
		assert.equal(
			text,
			isReadSummaryPath(path) ? candidate.text : source,
			"Production read violates its frozen selection",
		);
	else assert.equal(text, source, "Production raw fallback changed source bytes");
	return { ...candidate, defaultReadText: text, engineId: folder.id };
}
