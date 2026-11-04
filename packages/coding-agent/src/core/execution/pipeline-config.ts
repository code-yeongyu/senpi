/** The pipelines a session can run its tool calls on; `legacy` is the agent loop's own scheduler until S36 removes it. */
export type ExecutionPipeline = "legacy" | "prepared";

const DEFAULT_EXECUTION_PIPELINE: ExecutionPipeline = "prepared";

export interface ExecutionPipelineConfig {
	readonly pipeline: ExecutionPipeline;
	/** The flag named this pipeline; unset or `default` leaves the choice to the default. */
	readonly named: boolean;
}

/**
 * The pipeline the test/QA-only `SENPI_EXECUTION_PIPELINE` selects: unset, empty or `default` runs the default;
 * `legacy` or `prepared` names a pipeline. An unknown value is refused rather than silently running the default.
 */
export function resolveExecutionPipeline(env: NodeJS.ProcessEnv = process.env): ExecutionPipelineConfig {
	const value = env.SENPI_EXECUTION_PIPELINE;
	if (value === undefined || value === "" || value === "default")
		return { pipeline: DEFAULT_EXECUTION_PIPELINE, named: false };
	if (value === "legacy" || value === "prepared") return { pipeline: value, named: true };
	throw new Error(`SENPI_EXECUTION_PIPELINE must be legacy, prepared or default, got ${JSON.stringify(value)}`);
}
