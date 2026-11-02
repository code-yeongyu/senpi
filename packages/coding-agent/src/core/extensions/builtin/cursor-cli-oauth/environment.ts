export const CURSOR_AGENT_ENVIRONMENT_PASSTHROUGH = ["PATH", "TERM", "LANG", "LC_ALL", "FORCE_COLOR"] as const;

/**
 * The one environment every cursor-agent spawn receives (turns, `models`, `--version`).
 *
 * Security contract: nothing beyond the passthrough list crosses into the child, so
 * senpi secrets stay out and no `SSH_*`/`MOSH_*`/`VSCODE_SSH_*` marker arrives. The
 * latter is load-bearing on macOS - cursor-agent treats those markers as a remote
 * session and preflights the login keychain with `security add-generic-password`,
 * which blocks on a GUI "Keychain Not Found" dialog when `HOME` has no login
 * keychain (senpi#1722).
 */
export function cursorAgentEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		AGENT_CLI_CREDENTIAL_STORE: "file",
	};
	for (const name of CURSOR_AGENT_ENVIRONMENT_PASSTHROUGH) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}
