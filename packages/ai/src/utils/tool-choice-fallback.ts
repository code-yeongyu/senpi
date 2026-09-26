function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractHttpStatus(error: unknown): number | undefined {
	if (!isRecord(error)) {
		return undefined;
	}

	const status = error.status;
	if (typeof status === "number") {
		return status;
	}

	const response = error.response;
	if (isRecord(response) && typeof response.status === "number") {
		return response.status;
	}

	return undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return String(error);
}

export function isForcedToolChoiceUnsupportedError(error: unknown, sentForcedToolChoice: boolean): boolean {
	if (!sentForcedToolChoice) {
		return false;
	}

	const status = extractHttpStatus(error);
	if (status === 404 && isRecord(error) && isRecord(error.error)) {
		// OpenRouter can remove the allowed provider during tool compatibility filtering,
		// then report a guardrail 404. Retry without the forced choice, keeping routing policy.
		const metadata = error.error.metadata;
		if (!isRecord(metadata) || metadata.failed_routing_step !== "Filter by Guardrails") return false;
		const funnel = metadata.routing_funnel;
		if (!Array.isArray(funnel)) return false;
		return funnel.some((step, index) => {
			const previous: unknown = funnel[index - 1];
			return (
				isRecord(step) &&
				step.step === "Filter by Tool Compatibility" &&
				isRecord(previous) &&
				typeof previous.endpoint_count === "number" &&
				Number.isFinite(previous.endpoint_count) &&
				typeof step.endpoint_count === "number" &&
				Number.isFinite(step.endpoint_count) &&
				step.endpoint_count >= 0 &&
				step.endpoint_count < previous.endpoint_count
			);
		});
	}
	if (status !== 400) {
		return false;
	}

	const message = errorMessage(error);
	return (
		/tool[_\s-]?choices?\b.*?(not\s+compatible|incompatible|not\s+supported|unsupported)/is.test(message) ||
		/forces?\s+tool\s+use.*?(not\s+compatible|incompatible|not\s+supported|unsupported)/is.test(message) ||
		/does\s+not\s+support\s+forced\s+tool[_\s-]?choices?/is.test(message) ||
		// Anthropic Messages with extended thinking on: "Thinking may not be enabled when tool_choice forces tool use."
		/thinking\s+may\s+not\s+be\s+enabled\s+when\s+tool[_\s-]?choice\s+forces\s+tool\s+use/is.test(message) ||
		// OpenAI-compatible gateways serving always-thinking Claude models (observed on opengateway for
		// claude-fable-5-1, 2026-09-24): "This model always runs with thinking enabled, so tool_choice
		// cannot force tool use. Use tool_choice 'auto' or 'none'."
		/tool[_\s-]?choice\s+cannot\s+force\s+tool\s+use/is.test(message)
	);
}

export function omitToolChoiceParam<TParams extends { tool_choice?: unknown }>(params: TParams): TParams {
	const nextParams = { ...params };
	delete nextParams.tool_choice;
	return nextParams;
}
