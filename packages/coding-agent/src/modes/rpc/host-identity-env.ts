/**
 * The environment names an ensure uses to hand a spawned host its identity.
 *
 * They live in their own dependency-free module because the lifecycle supervisor needs them and
 * nothing else from `protocol-identity.ts`, whose launch-profile parsing imports the CLI argument
 * parser and, through it, the whole provider catalog. A supervisor runs once per task shard and
 * Desktop thread host, so that graph was resident in every one of them.
 *
 * This module must stay import-free: it is the single owner of the supervisor hand-off list, and
 * `utils/shell.ts`, the daemon env filter and the watchdog scrub all read it
 * (`test/suite/regressions/issue-5635-host-handoff-env-lists.test.ts` checks there is no import).
 */

/**
 * Generation of this host within its daemon directory, handed to it by the ensure call
 * that spawned it (the daemon settings travel to the host through its environment).
 * Absent - a bare host nobody ensured - is generation 0.
 */
export const HOST_GENERATION_ENV = "SENPI_RPC_HOST_GENERATION";

/**
 * Identity of the host being spawned, chosen by the ensure that spawns it so the daemon directory
 * can hold that generation's state before the process exists. A host nobody ensured names itself.
 */
export const HOST_INSTANCE_ID_ENV = "SENPI_RPC_HOST_INSTANCE_ID";

/**
 * Namespace of the internal-key hand-off a supervisor gives the host child it spawns. It belongs in
 * this module for the same reason the two names above do: the supervisor's launch writes it, and a
 * module of its own would be one more module in the supervisor's graph, which is a budget
 * (`test/supervisor-import-graph.test.ts`). `internal-bootstrap.ts` cannot own it either - importing
 * that module CONSUMES the sentinel at load, reading stdin and arming a SIGKILL deadline - so the
 * dependency-free hand-off module owns it and the bootstrap imports it from here.
 */
export const INTERNAL_KEY_ENV_PREFIX = "SENPI_RPC_INTERNAL_KEY";

/** Set to `1` when the child must read its 32-byte internal key from stdin before anything else. */
export const INTERNAL_KEY_STDIN_ENV = `${INTERNAL_KEY_ENV_PREFIX}_STDIN`;

/**
 * The host generation a process runs UNDER (senpi#5635). A host's children cannot carry the host's own
 * `SENPI_RPC_HOST_INSTANCE_ID` (a nested host would adopt it as its identity), so attribution for
 * senpi#3272's dependent-client rule travels under this name, which no host reads as identity.
 */
export const ORIGIN_HOST_INSTANCE_ENV = "SENPI_RPC_ORIGIN_HOST_INSTANCE";

/** The supervisor binding `consumeHostWatchdogEnv` reads once and deletes at host start (senpi#3815 L4). */
export const HOST_WATCH_ENV_NAMES = [
	"SENPI_RPC_HOST_WATCH_FD",
	"SENPI_RPC_HOST_WATCH_PPID",
	"SENPI_RPC_HOST_WATCH_PSTART",
	"SENPI_RPC_HOST_WATCH_PSTART_TICKS",
	"SENPI_RPC_HOST_LIFETIME_FIFO",
	"SENPI_RPC_HOST_SCRATCH_DIR",
	"SENPI_RPC_HOST_PUBLIC_SOCKET",
	"SENPI_RPC_HOST_CLEANUP_PATHS",
] as const;

/**
 * Everything a supervisor or an ensure hands ONE host process: its key sentinel, its watchdog binding and
 * its generation identity. Only that process may hold them; no child it starts for an agent does.
 */
export const HOST_HANDOFF_ENV_NAMES = [
	...HOST_WATCH_ENV_NAMES,
	INTERNAL_KEY_STDIN_ENV,
	"SENPI_RPC_SOCKET_SECRET_FILE",
	"SENPI_RPC_HOST_DAEMON_DIR",
	HOST_INSTANCE_ID_ENV,
	HOST_GENERATION_ENV,
	"SENPI_RPC_HOST_EXPECTED_RUNTIME_BUILD_ID",
] as const;

const HOST_HANDOFF_NAME_SET: ReadonlySet<string> = new Set(HOST_HANDOFF_ENV_NAMES);

/** An instance id counts only when it is non-blank, the rule `resolveInstanceId` applies. */
export function presentInstanceId(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/** Matched exactly on POSIX and case-insensitively on win32, where `PATH` and `Path` are one variable. */
export function isHostHandoffEnvName(name: string, platform: NodeJS.Platform = process.platform): boolean {
	const key = platform === "win32" ? name.toUpperCase() : name;
	return HOST_HANDOFF_NAME_SET.has(key) || key.startsWith(INTERNAL_KEY_ENV_PREFIX);
}

/**
 * The environment for a child this process starts for an agent (a shell, an eval kernel, the tool child):
 * a copy of `env` without the hand-off names, plus the origin attribution. Nothing else is read, rebuilt
 * or filtered, so platform state (PATH, the user's SSL_CERT_*, Windows system variables) passes as is.
 */
export function childEnvironmentOf(
	env: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {};
	let instanceId: string | undefined;
	for (const [name, value] of Object.entries(env)) {
		if (!isHostHandoffEnvName(name, platform)) {
			child[name] = value;
			continue;
		}
		if ((platform === "win32" ? name.toUpperCase() : name) === HOST_INSTANCE_ID_ENV) instanceId = value;
	}
	const origin = presentInstanceId(instanceId);
	if (origin !== undefined) child[ORIGIN_HOST_INSTANCE_ENV] = origin;
	return child;
}

/**
 * A socket host writes the identity it actually uses into its own env when none was handed to it (a bare
 * `--listen` host names itself), so its in-process clients and its children's origin agree with the id its
 * occupancy compares against. Called from `runSocketHost` only, never from `createHostCore`, which tests run
 * in-process (senpi#5635).
 */
export function publishHostInstanceId(instanceId: string, env: NodeJS.ProcessEnv = process.env): void {
	if (presentInstanceId(env[HOST_INSTANCE_ID_ENV]) === undefined) env[HOST_INSTANCE_ID_ENV] = instanceId;
}
