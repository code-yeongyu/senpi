/**
 * The headless engine: a multi-session RPC host with no UI that OWNS its sessions and their loops.
 * Clients and other sessions attach and detach over RPC; a detach never ends a session or a running
 * turn, and the engine does not exit for being empty. It needs only the engine's own configuration
 * (an agent dir, a cwd, a runtime factory) and reads nothing product-specific.
 */
import { posix, win32 } from "node:path";
import type { MultiSessionHostOptions } from "../rpc/multi-session-host.ts";
import { resolveSocketTransportAddress } from "../rpc/socket-transport.ts";

/** The headless engine's socket under `<agentDir>/rpc/`, apart from the shared host's `rpc.sock`. */
const HEADLESS_SOCKET_FILE = "headless.sock";

export type HeadlessHostOptions = Omit<MultiSessionHostOptions, "sessionOwner">;

export function headlessSocketPath(agentDir: string, platform: NodeJS.Platform = process.platform): string {
	return (platform === "win32" ? win32 : posix).join(agentDir, "rpc", HEADLESS_SOCKET_FILE);
}

/** The address a client dials: the socket path on POSIX, its named pipe on Windows. */
export function headlessEndpoint(
	agentDir: string,
	platform: NodeJS.Platform = process.platform,
	secret?: Uint8Array,
): string {
	return resolveSocketTransportAddress(headlessSocketPath(agentDir, platform), platform, secret);
}

export function headlessHostOptions(options: HeadlessHostOptions): MultiSessionHostOptions {
	return {
		...options,
		sessionOwner: "machine",
		listen: options.listen ?? `unix://${headlessSocketPath(options.agentDir)}`,
	};
}
