export interface ResolveContinuationConfigInput {
	globalSettings?: Record<string, unknown>;
	projectSettings?: Record<string, unknown>;
	cliFlag?: unknown;
}

export interface ResolvedContinuationConfig {
	enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getConfiguredEnabled(settings: Record<string, unknown> | undefined): boolean | undefined {
	if (!settings) {
		return undefined;
	}

	const todotools = settings.todotools;
	if (!isRecord(todotools)) {
		return undefined;
	}

	const continuation = todotools.continuation;
	if (!isRecord(continuation)) {
		return undefined;
	}

	return typeof continuation.enabled === "boolean" ? continuation.enabled : undefined;
}

export function resolveContinuationConfig({
	globalSettings,
	projectSettings,
	cliFlag,
}: ResolveContinuationConfigInput): ResolvedContinuationConfig {
	let enabled = true;

	const globalEnabled = getConfiguredEnabled(globalSettings);
	if (typeof globalEnabled === "boolean") {
		enabled = globalEnabled;
	}

	const projectEnabled = getConfiguredEnabled(projectSettings);
	if (typeof projectEnabled === "boolean") {
		enabled = projectEnabled;
	}

	if (cliFlag === true) {
		enabled = false;
	}

	return { enabled };
}
