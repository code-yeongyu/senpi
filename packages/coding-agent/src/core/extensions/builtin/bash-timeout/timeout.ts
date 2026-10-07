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

export interface BashTimeoutPromptOptions {
	/**
	 * `undefined` when no PTY bash tool is live (native Anthropic bash replaces
	 * it). Nothing implements auto-detach then, so the policy must not promise
	 * it — a prompt that describes impossible behavior is worse than a silent one.
	 */
	readonly foregroundWindowSeconds?: number;
	/** True when the session routes shell tools through eval cells, so call shapes must be `tool.<name>(`. */
}

export function buildBashTimeoutPrompt(defaults: BashTimeoutDefaults, options: BashTimeoutPromptOptions = {}): string {
	const { foregroundWindowSeconds } = options;
	const minutes = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`);
	const detachRules =
		foregroundWindowSeconds === undefined
			? ""
			: `\n- Foreground blocking stops at the ~${foregroundWindowSeconds}s window. A command still running then auto-detaches alive to a background session with a \`bash_id\` and keeps running until it exits or hits the kill deadline; the session tools in the terminal section steer or stop it.`;
	return `\n## Bash Tool Timeout Policy\n\nThe \`bash\` tool's \`timeout\` parameter is the process kill deadline, not how long you wait for output: the command is killed when it reaches the deadline.\n\n- Default timeout: ${defaults.defaultSeconds}s (${minutes(defaults.defaultSeconds)}). Applied automatically when you do not set \`timeout\`.\n- Recommended maximum timeout: ${defaults.maxSeconds}s (${minutes(defaults.maxSeconds)}). Explicit \`timeout\` values are preserved because different hosts may use different timeout units.${detachRules}`;
}
