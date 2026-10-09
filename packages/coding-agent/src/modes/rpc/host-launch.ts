/**
 * How a client re-enters this engine as a lifecycle supervisor.
 *
 * The supervisor owns the public socket and the idle-exit policy; it spawns the committed RPC
 * socket host itself. Both callers that start one - the ordinary ensure and a generation
 * handoff - build the same command here, so a rebranded binary, a compiled standalone and a
 * source checkout all agree on one re-entry route.
 */
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../config.ts";
import { runtimeExecArgv } from "../../utils/runtime-exec-argv.ts";
import { CUSTOM_UNSUPPORTED_CAPABILITY, EXTENSION_EVENTS_CAPABILITY } from "./custom-capability.ts";
import { INTERNAL_SUPERVISOR_FLAG, resolveCliMainPath } from "./host-lifecycle.ts";

/**
 * Every ensured host starts with this installation-wide profile, independent of the first
 * caller. In particular, extension_events must remain available when a terminal client starts
 * the shared host before the desktop connects.
 */
export const PINNED_HOST_CLIENT_CAPABILITIES = [EXTENSION_EVENTS_CAPABILITY, CUSTOM_UNSUPPORTED_CAPABILITY] as const;

/**
 * Builds the spawnable supervisor command for one supervisor argv
 * (`--socket <public> [--bind <path>] [--replace <dev>:<ino>] [host cli args...]`).
 *
 * A compiled standalone binary cannot re-enter itself through a script path: bun executables
 * always boot their embedded entrypoint and parse the whole argv as CLI arguments, so
 * `host-lifecycle.ts --socket <path>` dies with "Unknown option: --socket" before the host ever
 * answers get_protocol_info. Compiled binaries therefore re-enter through the hidden
 * `--internal-rpc-host-supervisor` route that main() dispatches before argument parsing.
 * Exported for tests.
 */
export function defaultHostLaunch(
	supervisorArgs: readonly string[],
	compiled: boolean = isBunBinary,
	/** Null stands for a bundled layout, where no standalone sibling program exists. */
	sibling: string | null = resolveHostLifecycleEntryPath() ?? null,
): { command: string; args: string[] } {
	if (compiled) return { command: process.execPath, args: [INTERNAL_SUPERVISOR_FLAG, ...supervisorArgs] };
	if (sibling !== null) return { command: process.execPath, args: [...runtimeExecArgv(), sibling, ...supervisorArgs] };
	// Bundled, the host-lifecycle entry beside us is a bundler chunk, not the standalone
	// program the unbundled tree ships: run directly it returns immediately without ever
	// listening, so ensure saw "exited with code 0 before answering get_protocol_info".
	// The CLI entry does honour the internal route in every layout, so re-enter it the way
	// compiled binaries do, taking the entry from the package's declared bin rather than
	// counting "..", which lands on the package root once this module is bundled.
	return {
		command: process.execPath,
		args: [...runtimeExecArgv(), resolveCliMainPath(), INTERNAL_SUPERVISOR_FLAG, ...supervisorArgs],
	};
}

/**
 * The standalone host-lifecycle program beside this module, or undefined when this module
 * has been bundled - there the neighbour of the same name is an emitted chunk that does not
 * start a supervisor on its own.
 */
function resolveHostLifecycleEntryPath(): string | undefined {
	const modulePath = fileURLToPath(import.meta.url);
	if (basename(dirname(modulePath)) === "chunks") return undefined;
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	const sibling = resolve(dirname(modulePath), `host-lifecycle${extension}`);
	return existsSync(sibling) ? sibling : undefined;
}
