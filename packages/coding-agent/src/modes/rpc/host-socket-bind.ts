/** Where a socket host listens and how it binds: the `--listen` address forms and the owned bind (moved out of multi-session-host.ts). */
import { chmod } from "node:fs/promises";
import type { Server } from "node:net";
import { join } from "node:path";
import { type SocketFileIdentity, statSocketIdentity } from "./socket-ownership.ts";
import { resolveSocketTransportAddress } from "./socket-transport.ts";

export function resolveSocketPath(value: string, agentDir: string): string {
	if (value === "unix://") return join(agentDir, "rpc", "rpc.sock");
	if (value.startsWith("unix://")) {
		const path = value.slice("unix://".length);
		if (path.length === 0) return join(agentDir, "rpc", "rpc.sock");
		if (path.startsWith("@") && process.platform === "linux") return `\0${path.slice(1)}`;
		return path;
	}
	return value;
}

export function formatSocketAddress(socketPath: string): string {
	return socketPath.startsWith("\0") ? `unix://@${socketPath.slice(1)}` : `unix://${socketPath}`;
}

export function listen(
	server: Server,
	socketPath: string,
	secret?: Uint8Array,
): Promise<SocketFileIdentity | undefined> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(resolveSocketTransportAddress(socketPath, process.platform, secret), async () => {
			server.off("error", reject);
			try {
				if (process.platform !== "win32" && !socketPath.startsWith("\0")) {
					await chmod(socketPath, 0o600);
					// Record which filesystem entry THIS listener created; shutdown
					// removes the path only while this identity still matches.
					return resolve(await statSocketIdentity(socketPath));
				}
				resolve(undefined);
			} catch (cause) {
				reject(cause);
			}
		});
	});
}
