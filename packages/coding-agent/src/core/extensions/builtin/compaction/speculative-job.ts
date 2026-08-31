import type { CompactionResult } from "../../../compaction/index.ts";
import type { SpeculativeCompactionSnapshot } from "./speculative.ts";

export interface SpeculativeJob {
	generation: number;
	snapshot: SpeculativeCompactionSnapshot;
	controller: AbortController;
	promise: Promise<CompactionResult | undefined>;
	failure: Promise<Error | undefined>;
	armedAtTokens: number;
	completed: boolean;
}

export function trackSpeculativeJob(input: {
	generation: number;
	snapshot: SpeculativeCompactionSnapshot;
	controller: AbortController;
	settled: Promise<{ result: CompactionResult | undefined; error: Error | undefined }>;
	armedAtTokens: number;
}): SpeculativeJob {
	const job: SpeculativeJob = {
		generation: input.generation,
		snapshot: input.snapshot,
		controller: input.controller,
		promise: input.settled.then(({ result }) => result),
		failure: input.settled.then(({ error }) => error),
		armedAtTokens: input.armedAtTokens,
		completed: false,
	};
	void input.settled.then(() => {
		job.completed = true;
	});
	return job;
}
