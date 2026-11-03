export const BASH_DEFAULT_TIMEOUT_SECONDS = 1800;
export const BASH_MAX_TIMEOUT_SECONDS = 1800;

export interface BashTimeoutDefaults {
	defaultSeconds: number;
	maxSeconds: number;
}

type EnvLike = Record<string, string | undefined>;

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

export function resolveBashTimeoutDefaults(env: EnvLike): BashTimeoutDefaults {
	const { PI_BASH_DEFAULT_TIMEOUT_SECONDS: defaultTimeout, PI_BASH_MAX_TIMEOUT_SECONDS: maxTimeout } = env;
	const defaultSeconds = parsePositiveInt(defaultTimeout) ?? BASH_DEFAULT_TIMEOUT_SECONDS;
	const rawMax = parsePositiveInt(maxTimeout) ?? BASH_MAX_TIMEOUT_SECONDS;
	const maxSeconds = Math.max(rawMax, defaultSeconds);
	return { defaultSeconds, maxSeconds };
}

export interface BashToolInputLike {
	command: string;
	timeout?: number;
	[key: string]: unknown;
}

export function applyBashTimeout<TInput extends BashToolInputLike>(
	input: TInput,
	defaults: BashTimeoutDefaults,
): TInput {
	const current = input.timeout;
	if (current === undefined || current <= 0) {
		return { ...input, timeout: defaults.defaultSeconds };
	}
	return input;
}
