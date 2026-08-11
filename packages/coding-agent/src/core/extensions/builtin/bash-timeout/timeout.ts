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

/**
 * `foregroundWindowSeconds` is `undefined` when no PTY bash tool is live (native
 * Anthropic bash replaces it). Nothing implements auto-detach then, so the
 * policy must not promise it — a prompt that describes impossible behavior is
 * worse than a silent one.
 */
export function buildBashTimeoutPrompt(defaults: BashTimeoutDefaults, foregroundWindowSeconds?: number): string {
	const minutes = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`);
	const detachRules =
		foregroundWindowSeconds === undefined
			? ""
			: `\n- Foreground blocking stops at the ~${foregroundWindowSeconds}s window. A command still running then auto-detaches alive to a background session with a \`bash_id\` and keeps running until it exits, hits the kill deadline, or is stopped with \`kill_bash\`.\n- Completion arrives automatically as a notification carrying the exit status and output tail, so end your turn rather than poll. Use \`bash_output\` only for a midpoint peek.`;
	return `\n## Bash Tool Timeout Policy\n\nThe \`bash\` tool's \`timeout\` parameter is the process kill deadline, not how long you wait for output: the command is killed when it reaches the deadline.\n\n- Default timeout: ${defaults.defaultSeconds}s (${minutes(defaults.defaultSeconds)}). Applied automatically when you do not set \`timeout\`.\n- Recommended maximum timeout: ${defaults.maxSeconds}s (${minutes(defaults.maxSeconds)}). Explicit \`timeout\` values are preserved because different hosts may use different timeout units.${detachRules}\n- Waiting on an observable condition (a log line, a CI check, a server coming up) belongs to \`monitor({command, filter})\`, never a foreground \`sleep\` or poll loop.\n- Sessions started with \`run_in_background: true\` ignore \`timeout\` and live until exit or \`kill_bash\`.\n`;
}
