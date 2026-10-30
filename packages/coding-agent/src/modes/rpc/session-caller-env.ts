/**
 * The per-spawn caller env channel (senpi#4381): the small, explicit set of environment variables a
 * caller may hand to the ONE session it opens, scoped to that session's tool subprocesses and to the task
 * children opened with `spawnedBy` naming it (`session-router-open-profile.ts`).
 *
 * A shared daemon serves every client on the machine, so a value that identifies one caller (a lane,
 * a work item) can never live in the daemon's own environment: the first caller's value would reach
 * every later child (#1195, #2208). It travels on the `open_session` request instead, after the daemon
 * allowlist has already been applied, and is stored on that session's launch profile only. Names are
 * checked against a passable set; values are never read by the host.
 *
 * The shipped default is exactly `OMOCAT_LANE`: a task child must carry the lane its parent works in so
 * the tools it runs label what they post correctly, and a daemon never inherits that name
 * (`host-daemon-env.ts` drops it). Every other name is passable only when the host was started with it
 * in `SENPI_RPC_CALLER_ENV_NAMES` (comma-separated); a session-owned or host-owned name never is.
 */
import { isTransientDaemonEnvName } from "./host-daemon-env.ts";

export type SessionEnv = Readonly<Record<string, string>>;

/** Comma-separated names the host additionally lets a caller pass; read from the host's own environment. */
export const CALLER_ENV_NAMES_ENV = "SENPI_RPC_CALLER_ENV_NAMES";

export const DEFAULT_CALLER_ENV_NAMES: readonly string[] = Object.freeze(["OMOCAT_LANE"]);

const MAX_SESSION_ENV_ENTRIES = 16;
const MAX_SESSION_ENV_VALUE_LENGTH = 4096;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
/** A refusal repeats at most this many characters of a caller-supplied name. */
const MAX_ECHOED_NAME_LENGTH = 64;

export function callerEnvPassableNames(
	hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<string> {
	const names = new Set<string>(DEFAULT_CALLER_ENV_NAMES);
	for (const raw of (hostEnv[CALLER_ENV_NAMES_ENV] ?? "").split(",")) {
		const name = raw.trim();
		if (ENV_NAME.test(name) && !isTransientDaemonEnvName(name)) names.add(name);
	}
	return names;
}

/** Detail for an `open_session.env` the host refuses by shape alone, or undefined when absent or well formed. */
export function sessionEnvShapeError(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) return "env must be an object of strings.";
	const entries = Object.entries(value);
	if (entries.length > MAX_SESSION_ENV_ENTRIES) return `env allows at most ${MAX_SESSION_ENV_ENTRIES} entries.`;
	for (const [name, entry] of entries) {
		if (!ENV_NAME.test(name)) return `env name "${echoedName(name)}" must match ${ENV_NAME.source}.`;
		if (typeof entry !== "string") return `env.${echoedName(name)} must be a string.`;
		if (entry.includes("\u0000")) return `env.${echoedName(name)} must not contain NUL.`;
		if (entry.length > MAX_SESSION_ENV_VALUE_LENGTH)
			return `env.${echoedName(name)} must be at most ${MAX_SESSION_ENV_VALUE_LENGTH} characters.`;
	}
	return undefined;
}

/**
 * Detail for an `open_session.env` the host refuses, or undefined when it is absent or every name is
 * caller-passable on this host. The refusal names the offending variable and the passable set, never a value.
 */
export function sessionEnvError(
	value: unknown,
	hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const shape = sessionEnvShapeError(value);
	if (shape !== undefined || !isPlainRecord(value)) return shape;
	const passable = callerEnvPassableNames(hostEnv);
	for (const name of Object.keys(value)) {
		if (!passable.has(name))
			return `env.${echoedName(name)} is not a caller-passable name (passable: ${[...passable].sort().join(", ")}).`;
	}
	return undefined;
}

/**
 * A task child's env: its parent's caller env, with the child's own explicit entries winning. Both are
 * already validated, so the result holds passable names only. Undefined when nothing remains.
 */
export function inheritedSessionEnv(
	parent: SessionEnv | undefined,
	requested: SessionEnv | undefined,
): SessionEnv | undefined {
	const merged = { ...parent, ...requested };
	return Object.keys(merged).length === 0 ? undefined : merged;
}

/** A caller-supplied name as a refusal repeats it: its first 64 characters, then `...` when longer. */
function echoedName(name: string): string {
	return name.length > MAX_ECHOED_NAME_LENGTH ? `${name.slice(0, MAX_ECHOED_NAME_LENGTH)}...` : name;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
