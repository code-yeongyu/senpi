/**
 * The engine side of the supervisor's private hop (senpi#3795): the stdin-delivered key and lifetime descriptor
 * from the bootstrap, and how each accepted connection is admitted. Split out of multi-session-host.ts.
 */
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { VERSION } from "../../config.ts";
import { consumeHostWatchdogEnv, type HostWatchdogConfig, scrubHostWatchdogEnv } from "./host-watchdog.ts";
import { getInternalHostBootstrap } from "./internal-bootstrap.ts";
import { acceptInternalConnection } from "./internal-channel.ts";
import { PublicRpcConnection } from "./rpc-public-auth.ts";
import { RpcPublicEndpoint } from "./rpc-public-key.ts";
import { authenticateSocket } from "./socket-transport.ts";

let binding: { readonly config: HostWatchdogConfig | undefined } | undefined;

/**
 * The supervisor binding, read once per process. The watch variables are removed as they are read (senpi#3815 review
 * L4), so no tool, shell or nested host this host starts inherits a binding to a supervisor that is not its own.
 */
export function hostWatchdogBinding(): HostWatchdogConfig | undefined {
	binding ??= { config: consumeHostWatchdogEnv() };
	return binding.config;
}

export interface InternalHostTransport {
	readonly watchdogConfig: HostWatchdogConfig | undefined;
	/** Authenticates and seals (POSIX key), authenticates (Windows secret), filters (public), or accepts as is. */
	admit(socket: Socket, accept: (socket?: Duplex) => void): void;
	/** Publishes the public endpoint's key record after listening; a failure is logged and `onFailure` ends the host. */
	publish(onFailure: () => Promise<void>): Promise<void>;
	dispose(): Promise<void>;
}

export function internalHostTransport(
	configured: HostWatchdogConfig | undefined,
	secret: Uint8Array | undefined,
	endpoint?: { readonly agentDir: string; readonly socket: string; readonly log: (message: string) => void },
): InternalHostTransport {
	const bootstrap = getInternalHostBootstrap();
	scrubHostWatchdogEnv();
	const watchdogConfig = configured && {
		...configured,
		...(bootstrap?.lifetimeFd === undefined ? {} : { lifetimeFd: bootstrap.lifetimeFd }),
	};
	// Supervised means holding the internal key, which only the launching supervisor can hand over and no descendant
	// inherits; a host without it is a public endpoint whatever its environment says (senpi#3815 review L4).
	const publicEndpoint =
		endpoint !== undefined && process.platform !== "win32" && bootstrap === undefined
			? new RpcPublicEndpoint(endpoint.agentDir, endpoint.socket)
			: undefined;
	return {
		watchdogConfig,
		admit(socket, accept) {
			if (bootstrap)
				void acceptInternalConnection(socket, bootstrap.key, { protocolVersion: 1, serverVersion: VERSION })
					.then(accept)
					.catch((cause: unknown) => {
						// One line per refused connection: the refusal code only (auth_required, auth_failed, a timeout).
						process.stderr.write(
							`senpi rpc host: internal connection refused: ${cause instanceof Error ? cause.message : "unknown"}\n`,
						);
						socket.destroy();
					});
			else if (secret) authenticateSocket(socket, secret, () => accept());
			else if (publicEndpoint) accept(new PublicRpcConnection(socket, publicEndpoint).stream);
			else accept();
		},
		async publish(onFailure) {
			try {
				await publicEndpoint?.publish();
			} catch (cause) {
				endpoint?.log(cause instanceof Error ? cause.message : String(cause));
				await onFailure();
			}
		},
		async dispose() {
			await publicEndpoint?.dispose().catch((cause: unknown) => {
				endpoint?.log(`endpoint key cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			});
		},
	};
}
