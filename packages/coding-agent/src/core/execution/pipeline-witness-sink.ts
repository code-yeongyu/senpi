import { appendFileSync } from "node:fs";
import type { ExecutionPipelineWitness } from "@earendil-works/pi-agent-core";

export type ExecutionPipelineWitnessSink = (witness: ExecutionPipelineWitness) => void;

/**
 * A witness sink OUTSIDE the session (S18b part 3): each receipt is one JSON line appended to `path`, so a session's own
 * entries never change. `SENPI_EXECUTION_PIPELINE_WITNESS=<path>` installs it when the session is not given a sink.
 */
function createWitnessFileSink(path: string): ExecutionPipelineWitnessSink {
	return (witness) => {
		appendFileSync(path, `${JSON.stringify({ pipeline: witness.pipeline, toolCallId: witness.toolCallId })}\n`);
	};
}

/** The sink a session uses: the configured one, else the file `SENPI_EXECUTION_PIPELINE_WITNESS` names, else none. */
export function resolveWitnessSink(
	configured: ExecutionPipelineWitnessSink | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ExecutionPipelineWitnessSink | undefined {
	if (configured !== undefined) return configured;
	const path = env.SENPI_EXECUTION_PIPELINE_WITNESS;
	return path === undefined || path === "" ? undefined : createWitnessFileSink(path);
}
