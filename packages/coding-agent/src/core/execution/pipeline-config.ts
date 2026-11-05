export interface ExecutionPipelineConfig {
	/** The flag named `prepared`; unset or `default` leaves the session's ToolHost alone. */
	readonly named: boolean;
}

/**
 * The test/QA-only `SENPI_EXECUTION_PIPELINE`. Since S36 the loop has one pipeline, the prepared one: unset, empty or
 * `default` runs it, and `prepared` names it. The removed `legacy` scheduler and unknown values are refused rather than
 * silently running the default under their name.
 */
export function resolveExecutionPipeline(env: NodeJS.ProcessEnv = process.env): ExecutionPipelineConfig {
	const value = env.SENPI_EXECUTION_PIPELINE;
	if (value === undefined || value === "" || value === "default") return { named: false };
	if (value === "prepared") return { named: true };
	throw new Error(`SENPI_EXECUTION_PIPELINE must be prepared or default, got ${JSON.stringify(value)}`);
}
