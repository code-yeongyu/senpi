import type { ExtensionAPI } from "../types.js";

export const BASH_DEFAULT_TIMEOUT_SECONDS = 120;
export const BASH_MAX_TIMEOUT_SECONDS = 600;

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
	const defaultSeconds = parsePositiveInt(env.PI_BASH_DEFAULT_TIMEOUT_SECONDS) ?? BASH_DEFAULT_TIMEOUT_SECONDS;
	const rawMax = parsePositiveInt(env.PI_BASH_MAX_TIMEOUT_SECONDS) ?? BASH_MAX_TIMEOUT_SECONDS;
	const maxSeconds = Math.max(rawMax, defaultSeconds);
	return { defaultSeconds, maxSeconds };
}

export interface BashToolInputLike {
	command: string;
	timeout?: number;
	[key: string]: unknown;
}

export function applyBashTimeout<T extends BashToolInputLike>(input: T, defaults: BashTimeoutDefaults): T {
	const current = input.timeout;
	if (current === undefined || current <= 0) {
		return { ...input, timeout: defaults.defaultSeconds };
	}
	if (current > defaults.maxSeconds) {
		return { ...input, timeout: defaults.maxSeconds };
	}
	return input;
}

export function buildBashTimeoutPrompt(defaults: BashTimeoutDefaults): string {
	const minutes = (seconds: number) => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`);
	return `\n## Bash Tool Timeout Policy\n\nThe \`bash\` tool enforces timeouts even when you omit the \`timeout\` parameter:\n\n- Default timeout: ${defaults.defaultSeconds}s (${minutes(defaults.defaultSeconds)}). Applied automatically when you do not set \`timeout\`.\n- Maximum timeout: ${defaults.maxSeconds}s (${minutes(defaults.maxSeconds)}). Larger values are silently capped to this maximum.\n- For long-running commands (builds, installs, test suites), set an explicit \`timeout\` that fits the workload. Do not assume commands run forever.\n- For commands that legitimately need to run beyond the maximum, run them in the background via tmux or a similar mechanism instead of relying on bash timeout.\n`;
}

export default function bashTimeoutExtension(pi: ExtensionAPI): void {
	const env = typeof process !== "undefined" ? process.env : {};
	const defaults = resolveBashTimeoutDefaults(env);
	const promptSection = buildBashTimeoutPrompt(defaults);

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as BashToolInputLike;
		const updated = applyBashTimeout(input, defaults);
		if (updated !== input) {
			input.timeout = updated.timeout;
		}
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}${promptSection}`,
		};
	});
}
