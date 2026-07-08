/**
 * Launch the neo shared daemon from the classic CLI.
 *
 * Dispatched from main.ts when `--listen <path>` is present. This runs the
 * daemon SUPERVISOR: it does NOT construct an AgentSessionRuntime in this
 * process — each accepted connection gets its own child `senpi --mode rpc`
 * worker with its own AuthStorage (see neo-daemon-mode.ts for the isolation
 * rationale). The supervisor owns the socket, the registry, and idle shutdown.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getPackageDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createNeoChildWorkerFactory } from "../../modes/rpc/neo-daemon-child-worker.ts";
import { NeoDaemonAddressInUseError, type NeoDaemonHandle, runNeoDaemon } from "../../modes/rpc/neo-daemon-mode.ts";
import type { Args } from "../args.ts";

/** Exit code the launcher uses when it lost the bind race to another daemon. */
export const NEO_DAEMON_ADDRESS_IN_USE_EXIT = 75;

export interface NeoDaemonLauncherDeps {
	/** Injectable error sink; defaults to console.error. */
	readonly errorSink?: (message: string) => void;
	/** Override the child worker's CLI entry base args (dev/test). */
	readonly workerBaseArgs?: readonly string[];
}

/**
 * Run the neo daemon supervisor. Resolves to the process exit code once the
 * daemon has fully shut down (idle or signal), or {@link NEO_DAEMON_ADDRESS_IN_USE_EXIT}
 * when another daemon already owns the socket.
 */
export async function runNeoDaemonLauncher(parsed: Args, deps: NeoDaemonLauncherDeps = {}): Promise<number> {
	const errorSink = deps.errorSink ?? ((message: string) => console.error(message));
	const listenPath = parsed.neoListen;
	if (!listenPath) {
		errorSink("Error: --listen requires a socket path");
		return 1;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const idleShutdownMs = settings.getNeoDaemonIdleShutdownMs();

	// The daemon mints its own token and publishes it in the registry; the
	// spawning client reads it back to complete the handshake.
	const token = randomBytes(24).toString("hex");

	const workerBaseArgs = deps.workerBaseArgs ?? resolveWorkerBaseArgs();
	const workerFactory = createNeoChildWorkerFactory({ baseArgs: workerBaseArgs });

	let handle: NeoDaemonHandle;
	try {
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			register: parsed.neoRegister === true,
			idleShutdownMs,
			token,
			workerFactory,
		});
	} catch (error) {
		if (error instanceof NeoDaemonAddressInUseError) {
			// Race lost: another daemon owns the socket. The client attaches to it.
			return NEO_DAEMON_ADDRESS_IN_USE_EXIT;
		}
		const message = error instanceof Error ? error.message : String(error);
		errorSink(`Error: failed to start neo daemon: ${message}`);
		return 1;
	}

	const shutdownOnSignal = (): void => {
		void handle.shutdown();
	};
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	for (const signal of signals) {
		process.on(signal, shutdownOnSignal);
	}

	await handle.closed;
	for (const signal of signals) {
		process.off(signal, shutdownOnSignal);
	}
	return 0;
}

/**
 * Resolve the base args used to spawn each connection's `senpi --mode rpc`
 * worker. `SENPI_NEO_WORKER_ARGS` (a JSON array of args following the node
 * executable, e.g. the tsx loader chain in dev) overrides the default built
 * `dist/rpc-entry.js` entry. This mirrors the `SENPI_NEO_BIN` dev override.
 */
export function resolveWorkerBaseArgs(): string[] {
	const override = process.env.SENPI_NEO_WORKER_ARGS;
	if (override) {
		try {
			const parsed: unknown = JSON.parse(override);
			if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string")) {
				return parsed;
			}
		} catch {
			// fall through to the default entry
		}
	}
	const pkgDir = getPackageDir();
	const distEntry = join(pkgDir, "dist", "rpc-entry.js");
	// Production ships a built dist; a dev checkout run from src may not have one
	// (or it is stale). When dist/rpc-entry.js is absent, fall back to the src
	// entry (node runs .ts natively) so daemon workers execute the SAME source as
	// the supervisor rather than failing to spawn / running stale code.
	if (!existsSync(distEntry)) {
		const srcEntry = join(pkgDir, "src", "rpc-entry.ts");
		if (existsSync(srcEntry)) {
			return [srcEntry];
		}
	}
	return [distEntry];
}
