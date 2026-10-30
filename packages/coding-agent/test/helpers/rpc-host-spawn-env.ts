/**
 * The environment a test gives a host it spawns.
 *
 * A supervisor hands its host child an internal lane through the environment: the key-on-stdin
 * sentinel, the watchdog binding, the daemon directory, the generation identity. When the process
 * running the tests is ITSELF such a host child - any runner started under a senpi RPC host - those
 * variables are in `process.env`, and a spawn that spreads `process.env` passes them on. The
 * spawned host then believes a supervisor is handing it a key, runs the stdin bootstrap with stdin
 * ignored, reads zero bytes and exits `internal_key_unavailable` before its ready line (senpi#4528).
 *
 * Every name below is imported from the module that declares it, and the list is checked against the
 * one place that writes the lane - `spawnHostChild` in `host-lifecycle-launch.ts` - by
 * `rpc-host-spawn-env.test.ts`, which fails when that function learns a variable this list does not
 * carry. The list is not derived automatically: it is a literal, kept honest by that test.
 */
import { HOST_DAEMON_DIR_ENV } from "../../src/modes/rpc/host-daemon-paths.ts";
import {
	HOST_GENERATION_ENV,
	HOST_INSTANCE_ID_ENV,
	INTERNAL_KEY_STDIN_ENV,
} from "../../src/modes/rpc/host-identity-env.ts";
import {
	HOST_CLEANUP_PATHS_ENV,
	HOST_PUBLIC_SOCKET_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_LIFETIME_FIFO_ENV,
	HOST_WATCH_PPID_ENV,
	HOST_WATCH_PSTART_ENV,
	HOST_WATCH_PSTART_TICKS_ENV,
} from "../../src/modes/rpc/host-watchdog.ts";
import { SOCKET_SECRET_FILE_ENV } from "../../src/modes/rpc/socket-transport.ts";

/** Every variable through which a supervisor hands its own host child a private lane. */
export const INTERNAL_HANDOFF_ENV_NAMES: readonly string[] = [
	INTERNAL_KEY_STDIN_ENV,
	HOST_DAEMON_DIR_ENV,
	HOST_GENERATION_ENV,
	HOST_INSTANCE_ID_ENV,
	HOST_CLEANUP_PATHS_ENV,
	HOST_PUBLIC_SOCKET_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_LIFETIME_FIFO_ENV,
	HOST_WATCH_PPID_ENV,
	HOST_WATCH_PSTART_ENV,
	HOST_WATCH_PSTART_TICKS_ENV,
	SOCKET_SECRET_FILE_ENV,
];

/**
 * `source` without the hand-off lane. A test that deliberately exercises one of these variables
 * still sets it: spread this first and the explicit value afterwards.
 */
export function hostSpawnEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...source };
	for (const name of INTERNAL_HANDOFF_ENV_NAMES) delete env[name];
	return env;
}
