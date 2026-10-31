import { stripManagedAuthEnvironment } from "./auth-environment.ts";

/**
 * Host variables that would redirect a `claude` CLI-store account away from its own dir: the secure-store redirect
 * (undocumented, moves only the keychain item), an inherited config dir, and the host's browser.
 */
const HOST_REDIRECT_NAMES = ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "BROWSER"] as const;

/** Inherited credentials the CLI reads from a file descriptor; they would beat the account's own login (senpi#4436). */
const INHERITED_CREDENTIAL_DESCRIPTORS = [
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
] as const;

export type ClaudeCliEnvironmentOptions = {
	/** The account's own config dir; the CLI keys its credential store on this path. */
	readonly configDir: string;
	/** The login's browser helper; omitted for status and logout. */
	readonly browser?: string;
};

/**
 * Environment for every `claude auth *` spawn of a CLI-store account. An inherited `CLAUDE_CODE_OAUTH_TOKEN` or
 * `ANTHROPIC_API_KEY` takes precedence over the stored claude.ai login inside the CLI, so they are stripped with the
 * rest of the managed auth set before the account dir is pinned.
 */
export function buildClaudeCliEnvironment(
	parent: NodeJS.ProcessEnv,
	options: ClaudeCliEnvironmentOptions,
): NodeJS.ProcessEnv {
	const environment = stripManagedAuthEnvironment(parent);
	for (const name of [...HOST_REDIRECT_NAMES, ...INHERITED_CREDENTIAL_DESCRIPTORS]) delete environment[name];
	environment.CLAUDE_CONFIG_DIR = options.configDir;
	environment.NO_COLOR = "1";
	if (options.browser !== undefined) environment.BROWSER = options.browser;
	return environment;
}
