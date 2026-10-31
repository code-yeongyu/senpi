/** Where both sides write payload references (`<root>/<generation>/`); the server owns and tears it down. */
export const TOOL_CHILD_REFS_ROOT_ENV = "SENPI_TOOL_CHILD_REFS_ROOT";

/** This generation's ledger path; the child reads it to sweep owned groups when its host disappears. */
export const TOOL_CHILD_LEDGER_ENV = "SENPI_TOOL_CHILD_LEDGER";
/** How to re-enter this engine (set by the server when it starts the tool child); the launch shim is started the same way. */
export const TOOL_CHILD_REENTRY_ENV = "SENPI_TOOL_CHILD_REENTRY";
/** The Windows command line a `launch-shim` starts outside the tool child's Job Object. */
export const LAUNCH_SHIM_COMMAND_LINE_ENV = "SENPI_LAUNCH_SHIM_COMMAND_LINE";

/**
 * Every variable the server sets only for the tool child itself. The child scrubs them from its own environment once it
 * has read them, so no command it starts inherits them (a nested senpi would otherwise enter the tool-child role).
 * `internal-env.test.ts` pins this list against the constants it names.
 */
export const TOOL_CHILD_INTERNAL_ENV = [
	"SENPI_INTERNAL_ROLE",
	"SENPI_TOOL_CHILD_CHANNEL",
	"SENPI_TOOL_CHILD_CHANNEL_SECRET",
	"SENPI_TOOL_CHILD_GENERATION",
	TOOL_CHILD_LEDGER_ENV,
	"SENPI_TOOL_CHILD_MODULE_ROOTS",
	TOOL_CHILD_REFS_ROOT_ENV,
	TOOL_CHILD_REENTRY_ENV,
] as const;

/** Every internal variable: the server's, and the ones the tool child sets for its own launch shim. */
export const INTERNAL_ENV = [...TOOL_CHILD_INTERNAL_ENV, LAUNCH_SHIM_COMMAND_LINE_ENV] as const;

/**
 * The one sanitizer for the environment of a command a user (or user code) asked for: none of the internal variables,
 * whatever platform path starts it. A user command that kept one could enter a senpi internal role or re-enter the shim.
 */
export function withoutInternalEnv(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	// Windows environment names are case-insensitive, so `senpi_tool_child_reentry` is the same variable there.
	const internal = new Set<string>(
		platform === "win32" ? INTERNAL_ENV.map((name) => name.toUpperCase()) : INTERNAL_ENV,
	);
	const key = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
	return Object.fromEntries(Object.entries(env).filter(([name]) => !internal.has(key(name))));
}

export function scrubToolChildEnv(env: NodeJS.ProcessEnv): void {
	for (const name of INTERNAL_ENV) delete env[name];
}

let reentry: string | undefined;

/** The tool child reads its re-entry command once, before the scrub; job workers get it through their worker data. */
export function rememberToolChildReentry(raw: string | undefined): void {
	reentry = raw;
}

export function toolChildReentry(): string | undefined {
	return reentry;
}
